#define UNICODE
#define _UNICODE
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

int wmain(void) {
  wchar_t directory[32768], executable[32768], script[32768], compiler[32768];
  DWORD length = GetModuleFileNameW(NULL, directory, 32768);
  if (!length || length >= 32768) return 1;
  wchar_t *separator = wcsrchr(directory, L'\\');
  if (!separator) return 1;
  *separator = L'\0';
  if (swprintf(executable, 32768, L"%ls\\AIScripter for ani.exe", directory) < 0 ||
      swprintf(script, 32768, L"%ls\\resources\\app.asar\\dist-tools\\aiscripter-mcp.cjs", directory) < 0 ||
      swprintf(compiler, 32768, L"%ls\\resources\\app.asar.unpacked\\node_modules\\@esbuild\\win32-x64\\esbuild.exe", directory) < 0) return 1;
  SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", L"1");
  SetEnvironmentVariableW(L"ESBUILD_BINARY_PATH", compiler);
  const wchar_t *arguments = GetCommandLineW();
  if (*arguments == L'"') {
    arguments++;
    while (*arguments && *arguments != L'"') arguments++;
    if (*arguments) arguments++;
  } else while (*arguments && *arguments != L' ' && *arguments != L'\t') arguments++;
  size_t capacity = wcslen(executable) + wcslen(script) + wcslen(arguments) + 8;
  if (capacity > 32767) return 1;
  wchar_t *command = calloc(capacity, sizeof(wchar_t));
  if (!command) return 1;
  swprintf(command, capacity, L"\"%ls\" \"%ls\"%ls", executable, script, arguments);
  STARTUPINFOW startup = {0};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION process = {0};
  BOOL created = CreateProcessW(executable, command, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, NULL, &startup, &process);
  free(command);
  if (!created) {
    fprintf(stderr, "AIScripter MCP could not start (Windows error %lu).\n", GetLastError());
    return 1;
  }
  CloseHandle(process.hThread);
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(process.hProcess, &code);
  CloseHandle(process.hProcess);
  return (int)code;
}
