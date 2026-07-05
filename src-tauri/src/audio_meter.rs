// WASAPI-peakmetrar för render-endpoints — grunden för "follow-the-audio"-loopbacken.
//
// Varför denna modul finns: Teams/Zoom/Slack routar samtalsljud till Windows *default
// kommunikationsenhet* (ofta ett BT-headsets HFP-endpoint), medan cpal:s
// default_output_device() alltid ger *console*-defaulten. Loopbacken kan därför lyssna
// på fel endpoint och MÖTET-kanalen blir tyst trots att mötet låter. Lösningen är att
// läsa av peaknivån på ALLA aktiva render-endpoints (IAudioMeterInformation fungerar
// utan att öppna en capture-ström) och låta huvudloopen i audio.rs binda om loopbacken
// till den endpoint som faktiskt låter.
//
// Multi-endpoint-fångst (mixa alla endpoints samtidigt) förkastades medvetet:
// session-recordern i audio.rs parar mic/sys sampel-för-sampel till stereo-WAV, och en
// andra samtidig sys-producent korrumperar WAV-tidslinjen och MergedVad. Per-process-
// loopback (AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK) vore den fullständiga
// lösningen men stöds inte av cpal — framtida möjlighet.
//
// All osäker COM-kod är isolerad här. Alla fel degraderar till tom Vec → audio.rs
// beter sig då exakt som före denna feature (binder till console-defaulten).

use std::cell::{Cell, RefCell};

use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
use windows::Win32::Media::Audio::{
    eRender, IMMDevice, IMMDeviceCollection, IMMDeviceEnumerator, MMDeviceEnumerator,
    DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
};

pub struct EndpointLevel {
    /// Friendly name — samma sträng som cpal exponerar som enhetsnamn,
    /// vilket gör namnmatchning mot cpal:s output_devices() tillförlitlig.
    pub name: String,
    /// Momentan peaknivå 0.0–1.0 från WASAPI:s inbyggda meter.
    pub peak: f32,
}

thread_local! {
    // CoInitializeEx per tråd, exakt en gång — obalanserad Uninitialize skulle kunna
    // riva COM under cpal som kör på samma tråd, och upprepade Init utan Uninitialize
    // växer referensräknaren obegränsat.
    static COM_INITIALIZED: Cell<bool> = const { Cell::new(false) };
    // Enumeratorn cachas per tråd — metersvepet anropar varje sekund under inspelning
    // och en CoCreateInstance per svep är onödigt COM-arbete. Vid fel (t.ex. omstartad
    // audio-tjänst) slängs cachen så att nästa anrop återskapar den.
    static ENUMERATOR: RefCell<Option<IMMDeviceEnumerator>> = const { RefCell::new(None) };
}

fn ensure_com_initialized() {
    COM_INITIALIZED.with(|initialized| {
        if !initialized.get() {
            // S_FALSE (redan initierad) och RPC_E_CHANGED_MODE (annan trådmodell,
            // t.ex. cpal:s STA) är båda OK — COM är användbart i bägge fallen.
            let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            initialized.set(true);
        }
    });
}

/// Kör `f` mot kollektionen av aktiva render-endpoints via den trådcachade
/// enumeratorn. Fel gör cachen ogiltig så att nästa anrop bygger en färsk enumerator.
fn with_active_render_endpoints<T>(
    f: impl FnOnce(&IMMDeviceCollection, u32) -> windows::core::Result<T>,
) -> windows::core::Result<T> {
    ensure_com_initialized();
    ENUMERATOR.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? });
        }
        let result = (|| {
            let collection = unsafe {
                slot.as_ref()
                    .unwrap()
                    .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?
            };
            let count = unsafe { collection.GetCount()? };
            f(&collection, count)
        })();
        if result.is_err() {
            *slot = None;
        }
        result
    })
}

/// Friendly name för en endpoint, eller None om den saknar/döljer namn.
fn friendly_name(device: &IMMDevice) -> Option<String> {
    unsafe {
        let store = device.OpenPropertyStore(STGM_READ).ok()?;
        let prop = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
        let name = prop.to_string();
        (!name.is_empty()).then_some(name)
    }
}

/// Peaknivå per aktiv render-endpoint. Fel på en enskild enhet hoppar över den;
/// alla andra fel ger tom Vec (featuren degraderar tyst till dagens beteende).
pub fn render_endpoint_levels() -> Vec<EndpointLevel> {
    match with_active_render_endpoints(|collection, count| {
        let mut levels = Vec::with_capacity(count as usize);
        for i in 0..count {
            let Ok(device) = (unsafe { collection.Item(i) }) else { continue };
            let Some(name) = friendly_name(&device) else { continue };
            let Ok(meter) =
                (unsafe { device.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None) })
            else {
                continue;
            };
            let Ok(peak) = (unsafe { meter.GetPeakValue() }) else { continue };
            levels.push(EndpointLevel { name, peak });
        }
        Ok(levels)
    }) {
        Ok(levels) => levels,
        Err(e) => {
            eprintln!("AUDIO METER: endpoint-enumerering misslyckades: {e}");
            Vec::new()
        }
    }
}

/// Finns en aktiv render-endpoint med exakt detta friendly name? Billigare än cpal:s
/// output_devices() som format-probar varje enhet — den här går bara igenom namnen.
/// COM-fel → true (anta att endpointen finns kvar): en faktiskt död pin fångas ändå av
/// cpal:s failed-flagga, medan ett falskt "försvunnen" skulle rycka loopbacken i onödan.
pub fn render_endpoint_exists(name: &str) -> bool {
    match with_active_render_endpoints(|collection, count| {
        for i in 0..count {
            let Ok(device) = (unsafe { collection.Item(i) }) else { continue };
            if friendly_name(&device).as_deref() == Some(name) {
                return Ok(true);
            }
        }
        Ok(false)
    }) {
        Ok(exists) => exists,
        Err(e) => {
            eprintln!("AUDIO METER: exists-kontroll misslyckades: {e}");
            true
        }
    }
}
