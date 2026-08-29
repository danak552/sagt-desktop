# Ändringar i Sagt.ai Desktop

Den här filen är **för användare**. Den beskriver vad som ändrats i appen, inte
hur eller varför det byggdes. Varje post skrivs för hand.

Changeloggen börjar vid 0.9.41. Äldre versioner finns inte dokumenterade här.

---

## 0.10.0 — 2026-08-29

### Nytt

- **Sagt.ai finns nu för Mac.** Samma app som på Windows: inspelning, lokal
  transkribering med KB-Whisper och mötesljud från Teams, Zoom och Meet — utan att
  någon bot ansluter till samtalet.

  Kräver **macOS 14.2 eller senare** och en Mac med **Apple Silicon** (M1 eller
  senare). Intel-Macar stöds inte.

  Vid första start frågar macOS om mikrofon, och om systemljud första gången du
  spelar in ett möte. Båda behövs för att mötets övriga deltagare ska komma med.

  Appen är godkänd av Apple, så den öppnas utan säkerhetsvarning — även utan
  internetanslutning.

### Ändrat

- **Nedladdningssidan visar rätt fil för din dator.** Båda versionerna finns
  alltid tillgängliga, så du kan hämta Mac-filen från en Windows-dator och tvärtom.
- **Installationsfilens storlek anges nu korrekt.** Sidan sa tidigare 165 MB;
  Windows-installern är 172 MB och Mac-filen 178 MB.

### För dig som använder Windows

Ingenting har ändrats i appen. Den här versionen finns för att Windows och Mac
släpps tillsammans, med samma versionsnummer.

---

## 0.9.44 — 2026-08-05

### Fixat

- **Pro syntes inte alltid direkt efter betalning.** Tog betalningen längre än
  fem minuter slutade appen leta, och uppgraderingserbjudandet kunde ligga kvar i
  upp till en halvtimme trots att köpet gått igenom. Appen fortsätter nu att
  kontrollera, och knappen "Uppdatera status" ger besked om vad den hittade.
- **Ingen bekräftelse vid lyckat köp.** Uppgraderingsdialogen visade prislistan
  igen i stället för att bekräfta att Pro aktiverats.
- **Nätverksfel beskrevs som utebliven prenumeration.** Den som saknade
  internetanslutning fick meddelandet "ingen prenumeration hittades" och kunde
  tro att köpet misslyckats.

---

## 0.9.43 — 2026-08-01

### Fixat

- **Ljudinställningarna tillämpades inte förrän du öppnat Inställningar.** Hade
  du ställt in tystnadströskel eller paustolerans men aldrig besökt fliken efter
  omstart körde appen sina egna standardvärden — medan gränssnittet visade dina.
- **Lokal transkribering körde svensk modell oavsett valt språk.** Norska och
  engelska gav därför tyst sämre text lokalt. Lokal transkribering är nu alltid
  svensk, och det framgår i gränssnittet. Molntranskribering (Pro) byter modell
  på riktigt.

### Ändrat

- **Inställningarna skrevs om.** Varje inställning har nu en kort synlig rad, och
  konsekvenserna ligger bakom ⓘ i stället för i löpande text.
- **Hem-vyn visade läget på tre ställen samtidigt** under inspelning. Nu på ett.

### Nytt

- **"Öppna mapp"** i Lokal lagring och på Inspelningar-sidan.

---

## 0.9.42 — 2026-07-24

### Fixat

- **Mikrofonen hölls öppen så länge appen var igång**, inte bara under
  inspelning. Det blockerade andra program — bland annat webbappen — från att
  spela in, med felet "Could not start audio source", ända tills Sagt stängdes.
  Mikrofonen öppnas nu bara när den behövs.

---

## 0.9.41 — 2026-07-16

### Ändrat

- **Felrapportering i skrivbordsappen.** Tidigare syntes det inte för oss när
  något gick sönder hos en användare — en misslyckad transkribering gav en röd
  ruta och inget mer. Appen rapporterar nu felkoder utan innehåll, så att
  återkommande problem går att hitta och åtgärda.
