#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(unsafe_op_in_unsafe_fn)]

use std::{
    path::PathBuf,
    process::Command,
    ptr,
    sync::atomic::{AtomicIsize, Ordering},
};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    Graphics::Gdi::{COLOR_WINDOW, DEFAULT_GUI_FONT, GetStockObject, HBRUSH, UpdateWindow},
    System::LibraryLoader::GetModuleHandleW,
    UI::WindowsAndMessaging::{
        BM_GETCHECK, BS_AUTOCHECKBOX, BS_PUSHBUTTON, CW_USEDEFAULT, CreateWindowExW,
        DefWindowProcW, DispatchMessageW, GetDlgItem, GetMessageW, HMENU, IDC_ARROW, LoadCursorW,
        MSG, PostQuitMessage, RegisterClassW, SW_SHOW, SendMessageW, SetWindowTextW, ShowWindow,
        TranslateMessage, WM_COMMAND, WM_DESTROY, WM_SETFONT, WNDCLASSW, WS_CHILD,
        WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    },
};

const ID_EXCLUDE: usize = 1101;
const ID_MONITOR: usize = 1102;
const ID_NONE: usize = 1103;
const ID_FOLDER: usize = 1104;
const ID_FULLSCREEN: usize = 1105;
const BST_CHECKED_VALUE: u32 = 1;

static STATUS_HANDLE: AtomicIsize = AtomicIsize::new(0);

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn main() {
    unsafe {
        let instance = GetModuleHandleW(ptr::null());
        if instance.is_null() {
            return;
        }

        let class_name = wide("OroWdaElectronLauncherWindow");
        let window_class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            hCursor: LoadCursorW(ptr::null_mut(), IDC_ARROW),
            hbrBackground: (COLOR_WINDOW as isize + 1) as HBRUSH,
            lpszClassName: class_name.as_ptr(),
            ..Default::default()
        };
        if RegisterClassW(&window_class) == 0 {
            return;
        }

        let title = wide("OroResea Browser WDA Lab — OroNimbus controller");
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            820,
            515,
            ptr::null_mut(),
            ptr::null_mut(),
            instance,
            ptr::null(),
        );
        if hwnd.is_null() {
            return;
        }

        create_controls(hwnd, instance);
        ShowWindow(hwnd, SW_SHOW);
        UpdateWindow(hwnd);

        let mut message = MSG::default();
        while GetMessageW(&mut message, ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

unsafe fn create_controls(hwnd: HWND, instance: *mut core::ffi::c_void) {
    let heading = create_child(
        hwnd,
        instance,
        "STATIC",
        "Launch a real Electron browser under a selected Windows Display Affinity mode",
        WS_CHILD | WS_VISIBLE,
        24,
        24,
        750,
        30,
        0,
    );
    let description = create_child(
        hwnd,
        instance,
        "STATIC",
        "The controller never protects itself. Each button starts OroNimbus.exe, and the Electron main process applies and reads WDA on its own BrowserWindow through a delay-loaded native module.",
        WS_CHILD | WS_VISIBLE,
        24,
        62,
        750,
        54,
        0,
    );
    let exclude = create_child(
        hwnd,
        instance,
        "BUTTON",
        "Launch EXCLUDE browser (0x11)",
        WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON as u32,
        24,
        132,
        355,
        40,
        ID_EXCLUDE,
    );
    let monitor = create_child(
        hwnd,
        instance,
        "BUTTON",
        "Launch MONITOR browser (0x01)",
        WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON as u32,
        399,
        132,
        355,
        40,
        ID_MONITOR,
    );
    let none = create_child(
        hwnd,
        instance,
        "BUTTON",
        "Launch unprotected browser (0x00)",
        WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON as u32,
        24,
        188,
        355,
        40,
        ID_NONE,
    );
    let folder = create_child(
        hwnd,
        instance,
        "BUTTON",
        "Open OroNimbus scan target",
        WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON as u32,
        399,
        188,
        355,
        40,
        ID_FOLDER,
    );
    let fullscreen = create_child(
        hwnd,
        instance,
        "BUTTON",
        "Launch browser in fullscreen (applies to EXCLUDE, MONITOR, and NONE)",
        WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX as u32,
        24,
        244,
        730,
        28,
        ID_FULLSCREEN,
    );
    let status = create_child(
        hwnd,
        instance,
        "STATIC",
        "Ready. Process name under test: OroNimbus.exe",
        WS_CHILD | WS_VISIBLE,
        24,
        292,
        750,
        48,
        0,
    );
    let note = create_child(
        hwnd,
        instance,
        "STATIC",
        "Static target: OroNimbus\\resources\\app.asar.unpacked\\native\\wda_native.node\r\nRuntime check: read the mode badge in the launched browser, or inspect its top-level HWND with GetWindowDisplayAffinity.",
        WS_CHILD | WS_VISIBLE,
        24,
        358,
        750,
        64,
        0,
    );
    STATUS_HANDLE.store(status as isize, Ordering::Relaxed);

    let font = GetStockObject(DEFAULT_GUI_FONT);
    for control in [
        heading,
        description,
        exclude,
        monitor,
        none,
        folder,
        fullscreen,
        status,
        note,
    ] {
        if !control.is_null() {
            SendMessageW(control, WM_SETFONT, font as usize, 1);
        }
    }
}

#[allow(clippy::too_many_arguments)]
unsafe fn create_child(
    parent: HWND,
    instance: *mut core::ffi::c_void,
    class_name: &str,
    text: &str,
    style: u32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    id: usize,
) -> HWND {
    let class_name = wide(class_name);
    let text = wide(text);
    CreateWindowExW(
        0,
        class_name.as_ptr(),
        text.as_ptr(),
        style,
        x,
        y,
        width,
        height,
        parent,
        id as HMENU,
        instance,
        ptr::null(),
    )
}

fn bundle_root() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|error| format!("Cannot resolve launcher path: {error}"))?
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "Launcher has no parent directory".to_owned())
}

fn browser_path() -> Result<PathBuf, String> {
    let path = bundle_root()?.join("OroNimbus").join("OroNimbus.exe");
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("OroNimbus.exe was not found at {}", path.display()))
    }
}

fn launch_browser(mode: &str, fullscreen: bool) -> Result<u32, String> {
    let path = browser_path()?;
    let working_directory = path
        .parent()
        .ok_or_else(|| "Invalid OroNimbus path".to_owned())?;
    let mut command = Command::new(&path);
    command.arg(format!("--wda={mode}"));
    if fullscreen {
        command.arg("--fullscreen");
    }
    command
        .current_dir(working_directory)
        .spawn()
        .map(|child| child.id())
        .map_err(|error| format!("Could not launch {}: {error}", path.display()))
}

fn open_scan_target() -> Result<(), String> {
    let folder = bundle_root()?.join("OroNimbus");
    if !folder.is_dir() {
        return Err(format!("Scan target was not found at {}", folder.display()));
    }
    Command::new("explorer.exe")
        .arg(&folder)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open scan target: {error}"))
}

unsafe fn report(value: &str) {
    let status = STATUS_HANDLE.load(Ordering::Relaxed) as HWND;
    if !status.is_null() {
        let value = wide(value);
        SetWindowTextW(status, value.as_ptr());
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_COMMAND => {
            let fullscreen_control = GetDlgItem(hwnd, ID_FULLSCREEN as i32);
            let fullscreen = !fullscreen_control.is_null()
                && SendMessageW(fullscreen_control, BM_GETCHECK, 0, 0) as u32 == BST_CHECKED_VALUE;
            let display = if fullscreen { "fullscreen" } else { "windowed" };
            let action = match wparam & 0xffff {
                ID_EXCLUDE => launch_browser("exclude", fullscreen).map(|pid| format!("Launched OroNimbus.exe PID {pid} {display} with requested WDA_EXCLUDEFROMCAPTURE (0x11)")),
                ID_MONITOR => launch_browser("monitor", fullscreen).map(|pid| format!("Launched OroNimbus.exe PID {pid} {display} with requested WDA_MONITOR (0x01)")),
                ID_NONE => launch_browser("none", fullscreen).map(|pid| format!("Launched OroNimbus.exe PID {pid} {display} with requested WDA_NONE (0x00)")),
                ID_FOLDER => open_scan_target().map(|_| "Opened the OroNimbus scan-target folder.".to_owned()),
                _ => return 0,
            };
            match action {
                Ok(value) => report(&value),
                Err(error) => report(&format!("Error: {error}")),
            }
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}
