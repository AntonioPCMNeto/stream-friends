# Captures one program's audio (or everything except one program) through the
# Windows process-loopback API (Windows 10 2004+) and writes it to stdout as raw
# 48 kHz / stereo / 16-bit PCM. Started by main.js; status goes to stderr:
#   MODE:<mode>    include or exclude, as actually used (it can differ from -Mode)
#   READY          capture is running
#   ERR:<reason>   it could not start (main falls back to the system audio)
# Usage: powershell -File win-process-loopback.ps1 -Mode include|exclude
#          (-TargetPid <n> | -Hwnd <n> | -Name <process name>) -DllPath <cache dll>
param(
  [Parameter(Mandatory = $true)][ValidateSet('include', 'exclude')][string]$Mode,
  [long]$TargetPid = 0,
  [long]$Hwnd = 0,
  [string]$Name = '',
  [int]$Flags = 0x00060000,
  [long]$Duration = 200000,
  [Parameter(Mandatory = $true)][string]$DllPath
)
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class ScrimaLoopback
{
    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig] int GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object activated);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAgileObject { }

    [ComVisible(true)]
    public class Handler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public ManualResetEvent Done = new ManualResetEvent(false);
        public int Result;
        public object Activated;
        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            int result; object activated;
            operation.GetActivateResult(out result, out activated);
            Result = result;
            Activated = activated;
            Done.Set();
            return 0;
        }
    }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    static extern void ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath, ref Guid riid, IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation operation);

    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("kernel32.dll")] static extern int WaitForSingleObject(IntPtr handle, int milliseconds);
    [DllImport("kernel32.dll")] static extern IntPtr CreateEvent(IntPtr attributes, bool manualReset, bool initialState, string name);

    public static uint PidOfWindow(long hwnd)
    {
        uint pid;
        GetWindowThreadProcessId(new IntPtr(hwnd), out pid);
        return pid;
    }

    static void Status(string line) { Console.Error.WriteLine(line); Console.Error.Flush(); }

    // mode: 0 = only this process tree, 1 = everything except it.
    public static int Run(int mode, uint pid, int streamFlags, long duration)
    {
        // AUDIOCLIENT_ACTIVATION_PARAMS { type = PROCESS_LOOPBACK(1), { pid, mode } } inside a VT_BLOB PROPVARIANT.
        IntPtr blob = Marshal.AllocHGlobal(12);
        Marshal.WriteInt32(blob, 0, 1);
        Marshal.WriteInt32(blob, 4, (int)pid);
        Marshal.WriteInt32(blob, 8, mode);
        IntPtr prop = Marshal.AllocHGlobal(24);
        for (int i = 0; i < 24; i += 8) Marshal.WriteInt64(prop, i, 0);
        Marshal.WriteInt16(prop, 0, 65);            // VT_BLOB
        Marshal.WriteInt32(prop, 8, 12);            // cbSize
        Marshal.WriteIntPtr(prop, 16, blob);        // pBlobData

        Guid iid = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        Handler handler = new Handler();
        IActivateAudioInterfaceAsyncOperation operation;
        try
        {
            ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, prop, handler, out operation);
        }
        catch (Exception e) { Status("ERR:activate-" + e.GetType().Name + "-" + e.Message); return 2; }
        if (!handler.Done.WaitOne(5000)) { Status("ERR:activate-timeout"); return 2; }
        if (handler.Result < 0 || handler.Activated == null) { Status("ERR:activate-hr-0x" + handler.Result.ToString("X8")); return 2; }
        IAudioClient client = (IAudioClient)handler.Activated;

        // 48 kHz / stereo / 16-bit PCM - the process-loopback device has no mix format to ask for.
        IntPtr fmt = Marshal.AllocHGlobal(18);
        Marshal.WriteInt16(fmt, 0, 1);              // WAVE_FORMAT_PCM
        Marshal.WriteInt16(fmt, 2, 2);              // channels
        Marshal.WriteInt32(fmt, 4, 48000);          // samples/sec
        Marshal.WriteInt32(fmt, 8, 192000);         // bytes/sec
        Marshal.WriteInt16(fmt, 12, 4);             // block align
        Marshal.WriteInt16(fmt, 14, 16);            // bits
        Marshal.WriteInt16(fmt, 16, 0);             // cbSize

        int hr = client.Initialize(0, streamFlags, duration, 0, fmt, IntPtr.Zero);
        if (hr < 0) { Status("ERR:initialize-hr-0x" + hr.ToString("X8")); return 2; }

        IntPtr evt = CreateEvent(IntPtr.Zero, false, false, null);
        hr = client.SetEventHandle(evt);
        if (hr < 0) { Status("ERR:seteventhandle-hr-0x" + hr.ToString("X8")); return 2; }

        Guid captureIid = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        object serviceObj;
        hr = client.GetService(ref captureIid, out serviceObj);
        if (hr < 0) { Status("ERR:getservice-hr-0x" + hr.ToString("X8")); return 2; }
        IAudioCaptureClient capture = (IAudioCaptureClient)serviceObj;

        hr = client.Start();
        if (hr < 0) { Status("ERR:start-hr-0x" + hr.ToString("X8")); return 2; }
        Status("READY");

        Stream stdout = Console.OpenStandardOutput();
        byte[] chunk = new byte[65536];
        try
        {
            while (true)
            {
                WaitForSingleObject(evt, 100);
                uint packet;
                while (capture.GetNextPacketSize(out packet) >= 0 && packet > 0)
                {
                    IntPtr data; uint frames, flags; ulong devicePos, qpcPos;
                    if (capture.GetBuffer(out data, out frames, out flags, out devicePos, out qpcPos) < 0) break;
                    int bytes = (int)frames * 4;
                    if (bytes > chunk.Length) bytes = chunk.Length;
                    if ((flags & 2) != 0) Array.Clear(chunk, 0, bytes);   // AUDCLNT_BUFFERFLAGS_SILENT
                    else Marshal.Copy(data, chunk, 0, bytes);
                    capture.ReleaseBuffer(frames);
                    stdout.Write(chunk, 0, bytes);
                }
                stdout.Flush();
            }
        }
        catch (IOException) { /* the reader went away: that is how we are told to stop */ }
        client.Stop();
        return 0;
    }
}
'@

try {
  if (-not (Test-Path $DllPath)) {
    Add-Type -TypeDefinition $source -OutputAssembly $DllPath
  }
  Add-Type -Path $DllPath
} catch {
  [Console]::Error.WriteLine('ERR:compile-' + $_.Exception.Message)
  exit 2
}

if ($Mode -eq 'include') {
  if ($TargetPid -le 0 -and $Hwnd -gt 0) { $TargetPid = [ScrimaLoopback]::PidOfWindow($Hwnd) }
  $owner = $null
  if ($TargetPid -gt 0) { $owner = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue }
  # A window that is gone, or a Store app's window (it belongs to ApplicationFrameHost,
  # not to the app that makes the sound), cannot be captured as "only this program":
  # fall back to "everything except -Name". Never look a program up by name in include mode.
  if (-not $owner -or $owner.ProcessName -eq 'ApplicationFrameHost') {
    $TargetPid = 0
    if ($Name) { $Mode = 'exclude' }
  }
}
if ($Mode -eq 'exclude' -and $TargetPid -le 0 -and $Name) {
  # -Name takes one or more comma-separated program names; the first one that is
  # running wins. A program is a tree of helper processes and the API takes the
  # tree's root, so pick the process whose parent is not the same program.
  foreach ($candidate in ($Name -split ',')) {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='$candidate.exe'" -ErrorAction SilentlyContinue)
    $ids = $procs | ForEach-Object { $_.ProcessId }
    $roots = @($procs | Where-Object { $ids -notcontains $_.ParentProcessId })
    if ($roots.Count -gt 0) { $TargetPid = $roots[0].ProcessId; break }
  }
}
if ($TargetPid -le 0) { [Console]::Error.WriteLine('ERR:not-running'); exit 3 }
[Console]::Error.WriteLine('MODE:' + $Mode)

exit ([ScrimaLoopback]::Run($(if ($Mode -eq 'exclude') { 1 } else { 0 }), [uint32]$TargetPid, $Flags, $Duration))
