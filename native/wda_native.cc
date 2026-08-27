#include <napi.h>
#include <windows.h>

#include <cstring>

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

Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
  exports.Set("apply", Napi::Function::New(env, ApplyAffinity));
  exports.Set("inspect", Napi::Function::New(env, InspectAffinity));
  exports.Set("WDA_NONE", Napi::Number::New(env, WDA_NONE));
  exports.Set("WDA_MONITOR", Napi::Number::New(env, WDA_MONITOR));
  exports.Set("WDA_EXCLUDEFROMCAPTURE",
              Napi::Number::New(env, WDA_EXCLUDEFROMCAPTURE));
  return exports;
}

}  // namespace

NODE_API_MODULE(wda_native, Initialize)
