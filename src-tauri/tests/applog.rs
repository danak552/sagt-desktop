//! Verifierar att filloggningen faktiskt fångar `println!`.
//!
//! Ligger i `tests/` och inte som `#[cfg(test)]`-modul med avsikt: `init` pekar om
//! processens fd 1 och 2, vilket hade slagit ut utskrifterna för ALLA andra tester
//! i samma binär. Ett eget testbinär isolerar den effekten.
//!
//! 🔴 Och det är ETT test, inte flera. Fd 1 och 2 är processglobala, medan Rust kör
//! tester parallellt i samma process — två tester som var för sig pekar om och
//! återställer dem trampar på varandra och ger sporadiska fel som inte har med
//! koden att göra. Uppmätt: uppdelat i två föll UTF-8-testet trots att skyddet
//! fanns. Alternativet vore `--test-threads=1`, men ett test som bara passerar med
//! en flagga är ett test som kommer att köras utan den.
//!
//! Testet sparar undan fd 1 och 2 innan omdirigeringen och återställer dem före
//! assertionerna — annars hade ett misslyckat test skrivit sitt felmeddelande till
//! loggfilen i stället för till terminalen, vilket är den sämsta möjliga platsen
//! för ett fel i just loggningen.
//!
//! ⚠️ Vi skriver med `libc::write` mot fd 1 och 2, inte med `println!`. Skälet är
//! inte kosmetiskt: Rusts testharness fångar `println!` OVANFÖR fd-lagret, så ett
//! test byggt på `println!` mäter harnesset och inte oss — det föll utan
//! `--nocapture` och passerade med, vilket är precis den sortens test som ser ut
//! att bevisa något och inte gör det. Fd-nivån är dessutom det appen faktiskt
//! förlitar sig på: i en GUI-startad app går `println!` rakt ned till fd 1.
//! `println!`-vägen är verifierad manuellt med `--nocapture`.

#[cfg(unix)]
#[test]
fn loggfilen_fangar_bada_stromarna_med_tidsstampel_och_overlever_skrap() {
    let dir = std::env::temp_dir().join(format!("sagt-applog-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    // SAFETY: 1 och 2 är öppna i ett testbinär; dup returnerar nya fd:n vi äger.
    let saved_out = unsafe { libc::dup(libc::STDOUT_FILENO) };
    let saved_err = unsafe { libc::dup(libc::STDERR_FILENO) };
    assert!(saved_out >= 0 && saved_err >= 0, "kunde inte spara std-fd:n");

    let path = desktop_lib::applog::init(&dir).expect("init misslyckades");
    skriv_till_fd(libc::STDOUT_FILENO, "MARKOR_STDOUT_7f3a\n");
    skriv_till_fd(libc::STDERR_FILENO, "MARKOR_STDERR_7f3a\n");

    // 0xFF är aldrig giltig UTF-8, i någon position. Utan skyddet i läsartråden är
    // detta ingen kosmetisk bugg utan en total hängning: lines() ger Err på en
    // sådan byte, tråden dör, pipens 64 KB fylls och varje println! i appen
    // blockerar i kärnan. Ett bibliotek vi inte äger räcker för att utlösa det.
    let skrap: [u8; 4] = [0xFF, 0xFE, 0xFF, b'\n'];
    // SAFETY: giltig pekare och längd, fd 1 är öppen.
    unsafe {
        libc::write(libc::STDOUT_FILENO, skrap.as_ptr() as *const libc::c_void, skrap.len())
    };
    skriv_till_fd(libc::STDOUT_FILENO, "EFTER_SKRAPET_9b21\n");

    // Läsartråden är asynkron — ge den en tick att konsumera pipen.
    std::thread::sleep(std::time::Duration::from_millis(500));

    // SAFETY: saved_* är giltiga fd:n från dup ovan. Återställs FÖRE assertionerna,
    // annars hade ett misslyckat test skrivit sitt felmeddelande till loggfilen i
    // stället för till terminalen — sämsta möjliga plats för ett fel i loggningen.
    unsafe {
        libc::dup2(saved_out, libc::STDOUT_FILENO);
        libc::dup2(saved_err, libc::STDERR_FILENO);
        libc::close(saved_out);
        libc::close(saved_err);
    }

    let innehall = std::fs::read_to_string(&path).expect("loggfilen gick inte att läsa");
    let _ = std::fs::remove_dir_all(&dir);

    assert!(
        innehall.contains("MARKOR_STDOUT_7f3a"),
        "stdout fångades inte. Loggen:\n{innehall}"
    );
    assert!(
        innehall.contains("MARKOR_STDERR_7f3a"),
        "stderr fångades inte — eprintln! gick förbi omdirigeringen. Loggen:\n{innehall}"
    );
    assert!(
        innehall.contains("EFTER_SKRAPET_9b21"),
        "läsartråden överlevde inte ogiltig UTF-8 — allt efter skräpbyten tappades, \
         vilket i appen betyder att pipen fylls och println! blockerar. Loggen:\n{innehall}"
    );

    // Tidsstämpeln är hela skälet till pipe-lösningen: utan den går loggen inte att
    // korrelera mot `log show`, och det var den korrelationen som löste buggen som
    // gjorde modulen nödvändig.
    let markorrad = innehall
        .lines()
        .find(|l| l.contains("MARKOR_STDOUT_7f3a"))
        .expect("markörraden saknas");
    let klockslag = &markorrad[..markorrad.find(' ').unwrap_or(0)];
    assert!(
        klockslag.len() == 12 && klockslag.matches(':').count() == 2 && klockslag.contains('.'),
        "raden saknar tidsstämpel i formen HH:MM:SS.mmm — fick {klockslag:?} ur {markorrad:?}"
    );
}

/// Skriver rakt på filbeskrivaren, förbi Rusts strömlager och därmed förbi
/// testharnessets utdatafångst.
#[cfg(unix)]
fn skriv_till_fd(fd: i32, text: &str) {
    let b = text.as_bytes();
    // SAFETY: fd är 1 eller 2, b pekar på giltiga bytes med känd längd.
    unsafe { libc::write(fd, b.as_ptr() as *const libc::c_void, b.len()) };
}
