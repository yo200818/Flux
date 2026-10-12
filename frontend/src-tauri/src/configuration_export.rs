use std::path::Path;

fn write_configuration(path: &Path, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents.as_bytes()).map_err(|error| {
        format!(
            "Could not write the PocketDeck configuration to '{}': {error}",
            path.display()
        )
    })
}

#[cfg(windows)]
pub fn save_configuration(contents: &str) -> Result<bool, String> {
    use std::mem::size_of;
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;
    use windows_sys::Win32::UI::Controls::Dialogs::{
        CommDlgExtendedError, GetSaveFileNameW, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT,
        OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };

    let filter: Vec<u16> = "PocketDeck configuration (*.json)\0*.json\0All files (*.*)\0*.*\0\0"
        .encode_utf16()
        .collect();
    let title: Vec<u16> = "Export PocketDeck configuration\0".encode_utf16().collect();
    let default_extension: Vec<u16> = "json\0".encode_utf16().collect();
    let mut file_buffer: Vec<u16> = "pocketdeck-configuration-v1.json\0"
        .encode_utf16()
        .collect();
    file_buffer.resize(32_768, 0);
    let mut dialog = OPENFILENAMEW {
        lStructSize: size_of::<OPENFILENAMEW>() as u32,
        lpstrFilter: filter.as_ptr(),
        nFilterIndex: 1,
        lpstrFile: file_buffer.as_mut_ptr(),
        nMaxFile: file_buffer.len() as u32,
        lpstrTitle: title.as_ptr(),
        lpstrDefExt: default_extension.as_ptr(),
        Flags: OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR,
        ..Default::default()
    };

    let selected = unsafe { GetSaveFileNameW(&mut dialog) };
    if selected == 0 {
        let error_code = unsafe { CommDlgExtendedError() };
        if error_code == 0 {
            return Ok(false);
        }
        return Err(format!(
            "Windows could not open the configuration save dialog (dialog error {error_code})."
        ));
    }

    let end = file_buffer
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(file_buffer.len());
    let path = PathBuf::from(std::ffi::OsString::from_wide(&file_buffer[..end]));
    write_configuration(&path, contents)?;
    Ok(true)
}

#[cfg(not(windows))]
pub fn save_configuration(_contents: &str) -> Result<bool, String> {
    Err("Configuration export is only available in the Windows desktop app.".to_string())
}

#[cfg(test)]
mod tests {
    use super::write_configuration;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn reports_filesystem_errors_with_the_export_path() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("the system clock should be after the Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir()
            .join(format!("pocketdeck-export-{unique}"))
            .join("configuration.json");

        let error = write_configuration(&path, "{}").unwrap_err();

        assert!(error.contains("Could not write the PocketDeck configuration"));
        assert!(error.contains(&path.display().to_string()));
    }
}
