{
  "targets": [{
    "target_name": "pynect_addon",
    "sources": [
      "src/native/pynect_addon.cpp",
      "src/native/python_bridge.cpp",
      "src/native/type_converter.cpp",
      "src/native/thread_pool.cpp",
      "src/native/gil_guard.cpp"
    ],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")",
      "<!(node -p \"process.env.PYNECT_PYTHON_INCLUDE_DIR || (() => { throw new Error('PYNECT_PYTHON_INCLUDE_DIR is required') })()\")"
    ],
    "cflags_cc": [
      "-std=c++17",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Wno-unused-parameter"
    ],
    "cflags!": ["-fno-exceptions"],
    "cflags_cc!": ["-fno-exceptions"],
    "defines": [
      "NAPI_CPP_EXCEPTIONS",
      "NAPI_VERSION=8",
      "PY_SSIZE_T_CLEAN"
    ],
    "conditions": [
      ["OS=='linux'", {
        "cflags_cc": ["-fvisibility=hidden"],
        "libraries": ["-ldl"],
        "ldflags": [
          "-static-libgcc",
          "-static-libstdc++"
        ]
      }],
      ["OS=='mac'", {
        "ldflags": ["-Wl,-undefined,dynamic_lookup"],
        "xcode_settings": {
          "MACOSX_DEPLOYMENT_TARGET": "11.0",
          "OTHER_CFLAGS": ["-std=c++17", "-stdlib=libc++"],
          "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
        }
      }],
      ["OS=='win'", {
        "libraries": [
          "<!(node -p \"process.env.PYNECT_PYTHON_LIBRARY || (() => { throw new Error('PYNECT_PYTHON_LIBRARY is required') })()\")"
        ],
        "msvs_settings": {
          "VCCLCompilerTool": {
            "ExceptionHandling": 1,
            "AdditionalOptions": ["/std:c++17"]
          }
        }
      }]
    ]
  }]
}
