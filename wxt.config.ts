import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  // Not the default `.output`: macOS hides dot-directories in the file picker,
  // which makes "load unpacked" needlessly fiddly.
  outDir: 'dist',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Page Guide',
    description: '在陌生的 Web 控制台上，一步步指出你该点哪里。只指路，不开车。',
    // Top Layer (popover) is a platform contract, not a progressive enhancement.
    minimum_chrome_version: '120',
    // `favicon` reads the site's icon out of Chrome's own cache for the panel
    // header (`_favicon/`): no request goes to the site. Measured with
    // `management.getPermissionWarningsByManifest`: it adds no warning beside
    // the <all_urls> grant below.
    permissions: ['scripting', 'sidePanel', 'storage', 'favicon'],
    // Deliberate, and the heaviest install-time warning Chrome has: "read and
    // change all your data on all websites". Decided 2026-08-07.
    //
    // Declared explicitly rather than inherited. WXT silently appends every
    // `registration: 'runtime'` content script's match patterns to
    // host_permissions (manifest.mjs:197-201), which is how this extension held
    // <all_urls> for the whole of step 1 while the config said `[]`. A grant
    // this broad must be visible in the config, not a build-time side effect.
    //
    // The guarantee that we only *read* is therefore no longer platform
    // enforced. It lives in architecture.spec.ts: no page-acting APIs anywhere
    // in src, and a closed RPC verb set with no execute verb.
    host_permissions: ['<all_urls>'],
    action: { default_title: '页面引导' },
    side_panel: { default_path: 'sidepanel.html' },
  },
});
