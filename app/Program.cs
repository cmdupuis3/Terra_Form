using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace TerraWBS;

static class Program
{
    [STAThread]
    static void Main()
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string? root = FindAppRoot();
        if (root is null)
        {
            MessageBox.Show(
                "index.html was not found next to Terra-WBS.exe (or in a parent folder).\n\n" +
                "Keep the exe in the terra-wbs folder alongside index.html and data\\.",
                "Terra-WBS", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        Application.Run(new MainForm(root));
    }

    // The exe normally sits in the app folder, but also tolerate running from
    // app\bin\... during development by walking up toward index.html.
    static string? FindAppRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 6 && dir is not null; i++, dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "index.html")))
                return dir.FullName;
        return null;
    }
}

class MainForm : Form
{
    const string Host = "terra-wbs.app";
    readonly string _root;
    readonly WebView2 _web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = System.Drawing.Color.FromArgb(0x0c, 0x18, 0x20) };

    public MainForm(string root)
    {
        _root = root;
        Text = "Terra-WBS";
        BackColor = System.Drawing.Color.FromArgb(0x0c, 0x18, 0x20);
        StartPosition = FormStartPosition.CenterScreen;
        WindowState = FormWindowState.Maximized;
        MinimumSize = new System.Drawing.Size(900, 600);
        try { Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        Controls.Add(_web);
        Load += async (_, _) => await InitAsync();
    }

    async Task InitAsync()
    {
        try
        {
            string userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Terra-WBS");
            var env = await CoreWebView2Environment.CreateAsync(null, userData);
            await _web.EnsureCoreWebView2Async(env);

            var core = _web.CoreWebView2;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = true;   // F12, Ctrl+F5 for debugging
            core.Settings.IsZoomControlEnabled = false;              // app owns scroll-to-zoom

            // Serve the app folder as https://terra-wbs.app/ so relative fetch('data/...')
            // works without any local HTTP server.
            core.SetVirtualHostNameToFolderMapping(Host, _root, CoreWebView2HostResourceAccessKind.Allow);

            core.DocumentTitleChanged += (_, _) =>
                Text = string.IsNullOrWhiteSpace(core.DocumentTitle) ? "Terra-WBS" : core.DocumentTitle;

            // Open any external links (fonts CDN pages etc.) in the system browser.
            core.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var u) && (u.Scheme == "http" || u.Scheme == "https"))
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(e.Uri) { UseShellExecute = true });
            };

            core.Navigate($"https://{Host}/index.html");
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Could not start the embedded browser (WebView2).\n\n" + ex.Message,
                "Terra-WBS", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }
}
