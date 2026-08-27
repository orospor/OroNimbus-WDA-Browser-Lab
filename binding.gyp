{
  "variables": {
    "win_delay_load_hook": "true"
  },
  "targets": [
    {
      "target_name": "wda_native",
      "sources": ["native/wda_native.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "libraries": ["user32.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 0,
          "DebugInformationFormat": 0
        },
        "VCLinkerTool": {
          "DelayLoadDLLs": ["user32.dll"],
          "GenerateDebugInformation": "false"
        }
      }
    }
  ]
}
