#include <napi.h>
#include <windows.h>
#include <tlhelp32.h>

#include <cstdint>
#include <cstring>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

namespace {

HWND ReadHwnd(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    Napi::TypeError::New(env, "Expected Electron native-window handle Buffer")
        .ThrowAsJavaScriptException();
    return nullptr;
  }

  auto handle_buffer = info[0].As<Napi::Buffer<unsigned char>>();
  if (handle_buffer.Length() < sizeof(HWND)) {
    Napi::RangeError::New(env, "Native-window handle Buffer is too small")
        .ThrowAsJavaScriptException();
    return nullptr;
  }

  HWND hwnd = nullptr;
  std::memcpy(&hwnd, handle_buffer.Data(), sizeof(HWND));
  return hwnd;
}

Napi::Object ReadAffinityResult(Napi::Env env, HWND hwnd) {
  DWORD affinity = 0;
  SetLastError(ERROR_SUCCESS);
  const BOOL ok = GetWindowDisplayAffinity(hwnd, &affinity);
  const DWORD error = ok ? ERROR_SUCCESS : GetLastError();

  Napi::Object result = Napi::Object::New(env);
  result.Set("getOk", Napi::Boolean::New(env, ok != FALSE));
  result.Set("affinity", Napi::Number::New(env, affinity));
  result.Set("getLastError", Napi::Number::New(env, error));
  return result;
}

Napi::Value ApplyAffinity(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND hwnd = ReadHwnd(info);
  if (env.IsExceptionPending()) {
    return env.Null();
  }
  if (info.Length() < 2 || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "Expected numeric WDA value")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  const DWORD requested = info[1].As<Napi::Number>().Uint32Value();
  if (requested != WDA_NONE && requested != WDA_MONITOR &&
      requested != WDA_EXCLUDEFROMCAPTURE) {
    Napi::RangeError::New(env, "Allowed values are WDA_NONE, WDA_MONITOR, and WDA_EXCLUDEFROMCAPTURE")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  SetLastError(ERROR_SUCCESS);
  const BOOL set_ok = SetWindowDisplayAffinity(hwnd, requested);
  const DWORD set_error = set_ok ? ERROR_SUCCESS : GetLastError();

  Napi::Object result = ReadAffinityResult(env, hwnd);
  result.Set("setOk", Napi::Boolean::New(env, set_ok != FALSE));
  result.Set("requested", Napi::Number::New(env, requested));
  result.Set("setLastError", Napi::Number::New(env, set_error));
  return result;
}

Napi::Value InspectAffinity(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND hwnd = ReadHwnd(info);
  if (env.IsExceptionPending()) {
    return env.Null();
  }
  return ReadAffinityResult(env, hwnd);
}

Napi::Value HardenDllSearch(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  SetLastError(ERROR_SUCCESS);
  const BOOL default_directories_ok =
      SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
  const DWORD default_directories_error =
      default_directories_ok ? ERROR_SUCCESS : GetLastError();

  // An empty string removes the current working directory from the legacy DLL
  // search order. This is intentionally process-local and affects only this
  // controlled OroNimbus fixture.
  SetLastError(ERROR_SUCCESS);
  const BOOL current_directory_removed_ok = SetDllDirectoryW(L"");
  const DWORD current_directory_removed_error =
      current_directory_removed_ok ? ERROR_SUCCESS : GetLastError();

  Napi::Object result = Napi::Object::New(env);
  result.Set("defaultDirectoriesOk",
             Napi::Boolean::New(env, default_directories_ok != FALSE));
  result.Set("defaultDirectoriesLastError",
             Napi::Number::New(env, default_directories_error));
  result.Set("currentDirectoryRemovedOk",
             Napi::Boolean::New(env, current_directory_removed_ok != FALSE));
  result.Set("currentDirectoryRemovedLastError",
             Napi::Number::New(env, current_directory_removed_error));
  result.Set("searchPolicy", "LOAD_LIBRARY_SEARCH_SYSTEM32 + empty DLL directory");
  return result;
}

struct CigPolicyReadback {
  BOOL ok = FALSE;
  DWORD last_error = ERROR_SUCCESS;
  PROCESS_MITIGATION_BINARY_SIGNATURE_POLICY policy = {};
};

CigPolicyReadback ReadCigPolicy() {
  CigPolicyReadback readback;
  SetLastError(ERROR_SUCCESS);
  readback.ok = GetProcessMitigationPolicy(
      GetCurrentProcess(), ProcessSignaturePolicy, &readback.policy,
      sizeof(readback.policy));
  readback.last_error = readback.ok ? ERROR_SUCCESS : GetLastError();
  return readback;
}

void AddCigReadback(Napi::Object result, const CigPolicyReadback& readback) {
  const bool microsoft_signed_only =
      readback.ok != FALSE && readback.policy.MicrosoftSignedOnly != 0;
  const bool signature_policy_effective =
      readback.ok != FALSE &&
      (readback.policy.MicrosoftSignedOnly != 0 ||
       readback.policy.StoreSignedOnly != 0 ||
       readback.policy.MitigationOptIn != 0);
  result.Set("getOk", Napi::Boolean::New(result.Env(), readback.ok != FALSE));
  result.Set("getLastError",
             Napi::Number::New(result.Env(), readback.last_error));
  result.Set("flags",
             Napi::Number::New(result.Env(), readback.policy.Flags));
  result.Set("microsoftSignedOnly",
             Napi::Boolean::New(result.Env(),
                                readback.policy.MicrosoftSignedOnly != 0));
  result.Set("storeSignedOnly",
             Napi::Boolean::New(result.Env(),
                                readback.policy.StoreSignedOnly != 0));
  result.Set("mitigationOptIn",
             Napi::Boolean::New(result.Env(),
                                readback.policy.MitigationOptIn != 0));
  result.Set("auditMicrosoftSignedOnly",
             Napi::Boolean::New(
                 result.Env(), readback.policy.AuditMicrosoftSignedOnly != 0));
  result.Set("auditStoreSignedOnly",
             Napi::Boolean::New(result.Env(),
                                readback.policy.AuditStoreSignedOnly != 0));
  result.Set("microsoftSignedOnlyEffective",
             Napi::Boolean::New(result.Env(), microsoft_signed_only));
  result.Set("signaturePolicyEffective",
             Napi::Boolean::New(result.Env(), signature_policy_effective));
  result.Set("effective",
             Napi::Boolean::New(result.Env(), signature_policy_effective));
}

Napi::Value InspectCig(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);
  const CigPolicyReadback readback = ReadCigPolicy();
  result.Set("requested", Napi::Boolean::New(env, false));
  result.Set("setAttempted", Napi::Boolean::New(env, false));
  result.Set("setOk", Napi::Boolean::New(env, false));
  result.Set("setLastError", Napi::Number::New(env, ERROR_SUCCESS));
  result.Set("preexisting",
             Napi::Boolean::New(
                 env, readback.ok != FALSE &&
                          (readback.policy.MicrosoftSignedOnly != 0 ||
                           readback.policy.StoreSignedOnly != 0 ||
                           readback.policy.MitigationOptIn != 0)));
  result.Set("beforeFlags", Napi::Number::New(env, readback.policy.Flags));
  result.Set("pid", Napi::Number::New(env, GetCurrentProcessId()));
  result.Set("timing", "inspection-only");
  result.Set("scope", "electron-main-wda-owner-only");
  result.Set("irreversibleForProcess", Napi::Boolean::New(env, true));
  AddCigReadback(result, readback);
  return result;
}

Napi::Value EnableCig(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const CigPolicyReadback before = ReadCigPolicy();

  PROCESS_MITIGATION_BINARY_SIGNATURE_POLICY requested_policy = {};
  requested_policy.MicrosoftSignedOnly = 1;
  SetLastError(ERROR_SUCCESS);
  const BOOL set_ok = SetProcessMitigationPolicy(
      ProcessSignaturePolicy, &requested_policy, sizeof(requested_policy));
  const DWORD set_error = set_ok ? ERROR_SUCCESS : GetLastError();
  const CigPolicyReadback after = ReadCigPolicy();

  Napi::Object result = Napi::Object::New(env);
  result.Set("requested", Napi::Boolean::New(env, true));
  result.Set("requestedPolicy", "MicrosoftSignedOnly");
  result.Set("setAttempted", Napi::Boolean::New(env, true));
  result.Set("setOk", Napi::Boolean::New(env, set_ok != FALSE));
  result.Set("setLastError", Napi::Number::New(env, set_error));
  result.Set("preexisting",
             Napi::Boolean::New(
                 env, before.ok != FALSE &&
                          (before.policy.MicrosoftSignedOnly != 0 ||
                           before.policy.StoreSignedOnly != 0 ||
                           before.policy.MitigationOptIn != 0)));
  result.Set("beforeGetOk", Napi::Boolean::New(env, before.ok != FALSE));
  result.Set("beforeGetLastError",
             Napi::Number::New(env, before.last_error));
  result.Set("beforeFlags", Napi::Number::New(env, before.policy.Flags));
  result.Set("pid", Napi::Number::New(env, GetCurrentProcessId()));
  result.Set("timing", "post-electron-executable-bootstrap");
  result.Set("scope", "electron-main-wda-owner-only");
  result.Set("irreversibleForProcess", Napi::Boolean::New(env, true));
  AddCigReadback(result, after);
  return result;
}

Napi::Value ProbeImageLoad(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  HMODULE containing_module = nullptr;
  SetLastError(ERROR_SUCCESS);
  if (!GetModuleHandleExW(
          GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
          reinterpret_cast<LPCWSTR>(&ProbeImageLoad), &containing_module)) {
    Napi::Error::New(env, "Could not resolve the native addon's module path")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::vector<wchar_t> module_path(32768, L'\0');
  SetLastError(ERROR_SUCCESS);
  const DWORD module_path_length = GetModuleFileNameW(
      containing_module, module_path.data(),
      static_cast<DWORD>(module_path.size()));
  if (module_path_length == 0 || module_path_length >= module_path.size()) {
    Napi::Error::New(env, "Could not read the native addon's module path")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::wstring image_path(module_path.data(), module_path_length);
  const size_t separator = image_path.find_last_of(L"\\/");
  if (separator == std::wstring::npos) {
    Napi::Error::New(env, "Native addon path has no parent directory")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  image_path.replace(separator + 1, std::wstring::npos,
                     L"cig_probe_unsigned.node");
  SetLastError(ERROR_SUCCESS);
  HMODULE module = LoadLibraryExW(
      image_path.c_str(), nullptr,
      LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
  const DWORD load_error = module != nullptr ? ERROR_SUCCESS : GetLastError();
  const BOOL free_ok = module != nullptr ? FreeLibrary(module) : FALSE;

  Napi::Object result = Napi::Object::New(env);
  result.Set("attempted", Napi::Boolean::New(env, true));
  result.Set("loaded", Napi::Boolean::New(env, module != nullptr));
  result.Set("loadLastError", Napi::Number::New(env, load_error));
  result.Set("blockedByCodeIntegrity",
             Napi::Boolean::New(
                 env, module == nullptr &&
                          load_error == ERROR_INVALID_IMAGE_HASH));
  result.Set("freed", Napi::Boolean::New(env, free_ok != FALSE));
  result.Set("expectedBlockedError",
             Napi::Number::New(env, ERROR_INVALID_IMAGE_HASH));
  result.Set("scope", "lab-owned-never-preloaded-unsigned-image");
  return result;
}

std::string WideToUtf8(const wchar_t* value) {
  if (value == nullptr || value[0] == L'\0') {
    return {};
  }

  const int required = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0, nullptr, nullptr);
  if (required <= 0) {
    return {};
  }

  std::string converted(static_cast<std::size_t>(required), '\0');
  const int written = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, converted.data(), required,
      nullptr, nullptr);
  if (written <= 0) {
    return {};
  }

  // WideCharToMultiByte includes the terminating NUL in `written` for an
  // input length of -1. JavaScript strings do not need that terminator.
  converted.resize(static_cast<std::size_t>(written - 1));
  return converted;
}

std::string FormatBaseAddress(const BYTE* base_address) {
  std::ostringstream formatted;
  formatted << "0x" << std::hex << std::uppercase << std::setfill('0')
            << std::setw(static_cast<int>(sizeof(void*) * 2))
            << reinterpret_cast<std::uintptr_t>(base_address);
  return formatted.str();
}

std::string ReadWindowsDirectory() {
  std::vector<wchar_t> buffer(MAX_PATH);
  for (;;) {
    const UINT written =
        GetWindowsDirectoryW(buffer.data(), static_cast<UINT>(buffer.size()));
    if (written == 0) {
      return {};
    }
    if (written < buffer.size()) {
      return WideToUtf8(buffer.data());
    }
    buffer.resize(static_cast<std::size_t>(written) + 1);
  }
}

HANDLE CreateCurrentProcessModuleSnapshot(DWORD* last_error) {
  constexpr int kMaxSnapshotAttempts = 8;
  HANDLE snapshot = INVALID_HANDLE_VALUE;
  *last_error = ERROR_SUCCESS;

  // The module list can change while Windows builds the snapshot. Microsoft
  // documents ERROR_BAD_LENGTH as a retry condition, so retry boundedly rather
  // than surfacing a transient loader race as a monitor failure.
  for (int attempt = 0; attempt < kMaxSnapshotAttempts; ++attempt) {
    SetLastError(ERROR_SUCCESS);
    snapshot = CreateToolhelp32Snapshot(
        TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, GetCurrentProcessId());
    if (snapshot != INVALID_HANDLE_VALUE) {
      return snapshot;
    }

    *last_error = GetLastError();
    if (*last_error != ERROR_BAD_LENGTH) {
      break;
    }
    SwitchToThread();
  }
  return INVALID_HANDLE_VALUE;
}

Napi::Value ListModules(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array modules = Napi::Array::New(env);
  bool ok = false;
  DWORD last_error = ERROR_SUCCESS;

  // This snapshot is deliberately restricted to the addon host process. The
  // API does not accept a PID and never opens or inspects another process.
  HANDLE snapshot = CreateCurrentProcessModuleSnapshot(&last_error);
  if (snapshot != INVALID_HANDLE_VALUE) {
    MODULEENTRY32W entry = {};
    entry.dwSize = sizeof(entry);

    SetLastError(ERROR_SUCCESS);
    if (!Module32FirstW(snapshot, &entry)) {
      last_error = GetLastError();
    } else {
      ok = true;
      std::uint32_t index = 0;
      for (;;) {
        Napi::Object module = Napi::Object::New(env);
        module.Set("name", Napi::String::New(env, WideToUtf8(entry.szModule)));
        module.Set("path", Napi::String::New(env, WideToUtf8(entry.szExePath)));
        module.Set("baseAddress",
                   Napi::String::New(env, FormatBaseAddress(entry.modBaseAddr)));
        module.Set("size", Napi::Number::New(env, entry.modBaseSize));
        modules.Set(index++, module);

        entry.dwSize = sizeof(entry);
        SetLastError(ERROR_SUCCESS);
        if (!Module32NextW(snapshot, &entry)) {
          const DWORD enumeration_error = GetLastError();
          if (enumeration_error != ERROR_NO_MORE_FILES) {
            ok = false;
            last_error = enumeration_error;
          }
          break;
        }
      }
    }

    SetLastError(ERROR_SUCCESS);
    if (!CloseHandle(snapshot) && ok) {
      ok = false;
      last_error = GetLastError();
    }
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("ok", Napi::Boolean::New(env, ok));
  result.Set("lastError", Napi::Number::New(env, last_error));
  result.Set("windowsDirectory",
             Napi::String::New(env, ReadWindowsDirectory()));
  result.Set("modules", modules);
  return result;
}

Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
  exports.Set("apply", Napi::Function::New(env, ApplyAffinity));
  exports.Set("inspect", Napi::Function::New(env, InspectAffinity));
  exports.Set("hardenDllSearch", Napi::Function::New(env, HardenDllSearch));
  exports.Set("enableCig", Napi::Function::New(env, EnableCig));
  exports.Set("inspectCig", Napi::Function::New(env, InspectCig));
  exports.Set("probeImageLoad", Napi::Function::New(env, ProbeImageLoad));
  exports.Set("listModules", Napi::Function::New(env, ListModules));
  exports.Set("WDA_NONE", Napi::Number::New(env, WDA_NONE));
  exports.Set("WDA_MONITOR", Napi::Number::New(env, WDA_MONITOR));
  exports.Set("WDA_EXCLUDEFROMCAPTURE",
              Napi::Number::New(env, WDA_EXCLUDEFROMCAPTURE));
  return exports;
}

}  // namespace

NODE_API_MODULE(wda_native, Initialize)
