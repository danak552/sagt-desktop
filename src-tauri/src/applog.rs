//! Apploggning till fil.
//!
//! # Varför modulen finns
//!
//! Appen hade 90 `println!`/`eprintln!`-anrop och **ingen av dem gick någonstans**.
//! Uppmätt på den installerade appen 2026-08-30 med `lsof -p <pid>`: fd 0, 1 och 2
//! pekade alla på `/dev/null`. En GUI-app startad från Finder ärver inga
//! terminalströmmar, så all instrumentering kastades bort.
//!
//! Följden blev konkret samma dag: en intermittent bugg där mikrofonen tystnade
//! kunde bara diagnosticeras genom att läsa macOS EGNA loggar via `/usr/bin/log` —
//! på utvecklarens maskin, i realtid. Hos en användare hade det inte funnits
//! någonting alls utöver en WAV-fil på 32 044 byte. En app som tiger både när den
//! fungerar och när den fallerar går inte att stödja i fält.
//!
//! # Varför omdirigering i stället för en loggmakro
//!
//! Alternativet var att byta ut 90 anropsplatser mot ett eget makro. Den här vägen
//! fångar dem alla utan att röra en enda rad — och fångar dessutom panics (som
//! skriver till stderr), utdata från bibliotek vi inte äger, och varje framtida
//! `println!` någon lägger till utan att känna till den här modulen.
//!
//! # Varför en pipe och inte `dup2` rakt på filen
//!
//! `dup2` direkt mot filen hade gett en logg UTAN tidsstämplar, eftersom de
//! befintliga anropen inte skriver några. Just tidskorrelationen mot `log show`
//! var det som knäckte buggen ovan, så en logg utan klockslag hade varit
//! halvvärdelös. Vi dup2:ar därför mot skrivänden av en pipe och låter en
//! läsartråd stämpla varje rad innan den når filen.

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

/// Rotera när filen passerar den här storleken. 5 MB räcker till många sessioner
/// av den ordrika DEBUG-utdata appen redan producerar, och är litet nog att kunna
/// bifogas i ett supportärende.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// Startar filloggningen och returnerar sökvägen till den aktiva loggfilen.
///
/// Anropas så tidigt som möjligt i `setup`, så att även uppstartens utskrifter
/// fångas. Fel här får ALDRIG hindra appen från att starta — en app som vägrar
/// köra för att den inte kunde öppna sin loggfil vore ett sämre fel än det den
/// försöker göra felsökbart. Därför `Result` som anroparen får logga och släppa.
pub fn init(app_data_dir: &Path) -> std::io::Result<PathBuf> {
    let dir = app_data_dir.join("logs");
    fs::create_dir_all(&dir)?;
    let path = dir.join("sagt.log");

    // En generation bakåt sparas. Skälet att spara någon alls: felet man vill läsa
    // om har ofta redan hänt när användaren hör av sig, och en rotation mitt i
    // sessionen skulle annars radera just det.
    if fs::metadata(&path).map(|m| m.len() >= MAX_LOG_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("sagt.log.1"));
    }

    let file = OpenOptions::new().create(true).append(true).open(&path)?;
    spawn_redirect(path.clone(), file)?;

    println!(
        "=== Sagt.ai {} ({}) startad {} ===",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f")
    );
    Ok(path)
}

/// Kopplar processens stdout och stderr till en pipe vars läsände stämplas och
/// skrivs till `file`.
#[cfg(unix)]
fn spawn_redirect(path: PathBuf, mut file: File) -> std::io::Result<()> {
    // Importerna bor HÄR, inte på modulnivå: de används bara i den unix-gatade
    // vägen, och på Windows kompileras funktionen bort — då blir de oanvända och
    // `Desktop Rust (release warnings)` fäller bygget. Fångat av just den grinden
    // på första releasen efter att den lagades, 2026-08-30.
    use std::io::{BufRead, BufReader, Seek, Write};
    use std::os::unix::io::FromRawFd;

    let mut fds = [0i32; 2];
    // SAFETY: `fds` är en giltig array om två i32. pipe() skriver exakt två fd:n.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let (read_fd, write_fd) = (fds[0], fds[1]);

    // SAFETY: write_fd är öppen och giltig. dup2 stänger målets tidigare fd.
    // Både 1 och 2 pekas om, så eprintln! hamnar i samma ström och därmed i samma
    // tidsordning som println! — de var tidigare två oberoende strömmar.
    for target in [libc::STDOUT_FILENO, libc::STDERR_FILENO] {
        if unsafe { libc::dup2(write_fd, target) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    // SAFETY: write_fd är duplicerad till 1 och 2 och behövs inte längre separat.
    unsafe { libc::close(write_fd) };

    let mut written = file.stream_position().unwrap_or(0);

    std::thread::Builder::new()
        .name("applog".into())
        .spawn(move || {
            // SAFETY: read_fd ägs härifrån och stängs när File droppas.
            let mut reader = BufReader::new(unsafe { File::from_raw_fd(read_fd) });
            let mut buf: Vec<u8> = Vec::with_capacity(1024);
            loop {
                buf.clear();
                // 🔴 `read_until` på BYTES, inte `lines()`. `lines()` ger
                // Err(InvalidData) på en enda icke-UTF-8-byte, och att avsluta
                // tråden på det hade varit ett självmål av värsta slag: pipen
                // fylls då till sina 64 KB och VARJE println! i appen blockerar
                // i kärnan för alltid. Loggningen som infördes för att göra
                // hängningar felsökbara hade själv blivit en hängning.
                // Ett bibliotek vi inte äger räcker för att utlösa det.
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) => break, // EOF: skrivänden stängd, processen avslutas
                    Ok(_) => {}
                    Err(_) => {
                        // Aldrig break. Sov kort så ett ihållande fel inte blir
                        // en varvande tråd, och fortsätt läsa.
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        continue;
                    }
                }
                let line = String::from_utf8_lossy(&buf);
                let line = line.trim_end_matches(['\n', '\r']);
                let rad = format!(
                    "{} {}\n",
                    chrono::Local::now().format("%H:%M:%S%.3f"),
                    line
                );
                // Skrivfel ignoreras av samma skäl som läsfel: en full disk får
                // inte frysa appen. Att tappa loggrader är alltid billigare.
                if file.write_all(rad.as_bytes()).is_ok() {
                    written += rad.len() as u64;
                    let _ = file.flush();
                }

                // Rotationen måste ske HÄR, inte bara i init: den session man vill
                // läsa är just den som loggar tätt, och en kontroll som bara körs
                // vid start hade låtit den växa fritt hela dagen.
                if written >= MAX_LOG_BYTES {
                    let _ = fs::rename(&path, path.with_extension("log.1"));
                    match OpenOptions::new().create(true).append(true).open(&path) {
                        Ok(f) => {
                            file = f;
                            written = 0;
                        }
                        // Gick den inte att öppna: fortsätt skriva i den gamla
                        // (nu omdöpta) filen hellre än att tappa loggningen helt.
                        Err(_) => written = 0,
                    }
                }
            }
        })?;
    Ok(())
}

/// Windows har samma tomma-strömmar-problem, men lösningen är en annan
/// (`SetStdHandle` via `windows`-craten) och den plattformen är inte den akuta.
/// Medvetet ogjord i stället för halvgjord — se `AI_KNOWLEDGE_BASE.md` §4.
#[cfg(not(unix))]
fn spawn_redirect(_path: PathBuf, _file: File) -> std::io::Result<()> {
    Ok(())
}
