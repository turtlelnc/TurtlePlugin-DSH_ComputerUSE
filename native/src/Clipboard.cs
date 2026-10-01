// TurtlePlugin-DSH_ComputerUSE — native driver
// Clipboard access through Win32 directly, so long or non-ASCII text can be
// pasted through the application's own paste path instead of being typed
// character by character (which most IMEs and rich editors corrupt).
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace TurtleComputerUse
{
    internal static class Clipboard
    {
        private const uint CF_UNICODETEXT = 13;
        private const uint GMEM_MOVEABLE = 0x0002;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool OpenClipboard(IntPtr hWndNewOwner);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool CloseClipboard();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool EmptyClipboard();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GlobalLock(IntPtr hMem);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GlobalUnlock(IntPtr hMem);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GlobalFree(IntPtr hMem);

        /// <summary>Replace the clipboard text. Retries while another process holds the clipboard open.</summary>
        public static void SetText(string text)
        {
            if (text == null) text = "";
            var bytes = (text.Length + 1) * 2;
            Exception last = null;
            for (int attempt = 0; attempt < 12; attempt++)
            {
                IntPtr handle = IntPtr.Zero;
                if (!OpenClipboard(IntPtr.Zero))
                {
                    last = new InvalidOperationException("OpenClipboard failed (Win32 error " + Marshal.GetLastWin32Error() + ")");
                    Thread.Sleep(60);
                    continue;
                }
                try
                {
                    if (!EmptyClipboard())
                    {
                        last = new InvalidOperationException("EmptyClipboard failed (Win32 error " + Marshal.GetLastWin32Error() + ")");
                        continue;
                    }
                    handle = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)bytes);
                    if (handle == IntPtr.Zero)
                    {
                        last = new InvalidOperationException("GlobalAlloc failed (Win32 error " + Marshal.GetLastWin32Error() + ")");
                        continue;
                    }
                    IntPtr locked = GlobalLock(handle);
                    if (locked == IntPtr.Zero)
                    {
                        last = new InvalidOperationException("GlobalLock failed (Win32 error " + Marshal.GetLastWin32Error() + ")");
                        continue;
                    }
                    try
                    {
                        var buffer = new byte[bytes];
                        System.Text.Encoding.Unicode.GetBytes(text, 0, text.Length, buffer, 0);
                        Marshal.Copy(buffer, 0, locked, bytes);
                    }
                    finally { GlobalUnlock(handle); }

                    if (SetClipboardData(CF_UNICODETEXT, handle) == IntPtr.Zero)
                    {
                        last = new InvalidOperationException("SetClipboardData failed (Win32 error " + Marshal.GetLastWin32Error() + ")");
                        continue;
                    }
                    handle = IntPtr.Zero; // ownership transferred to the clipboard
                    return;
                }
                finally
                {
                    if (handle != IntPtr.Zero) GlobalFree(handle);
                    CloseClipboard();
                }
            }
            throw new ProtocolException("clipboard_failed",
                "Could not write to the clipboard after several attempts: " + (last == null ? "unknown error" : last.Message) +
                ". The desktop may be locked, or a clipboard manager is holding the clipboard open.");
        }
    }
}
