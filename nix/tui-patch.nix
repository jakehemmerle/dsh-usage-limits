# dsh-TUI contribution of dsh-usage-limits (DSH plugin repository contract, nix/tui-patch.nix).
# nix-dsh's `dsh-tui.override { plugins = [ (import ./nix/tui-patch.nix { }) ]; }` applies it.
#
# launchpad-status: dsh-TUI 0.15.0 renders plugin status contributions (ctx.tuiStatus text and
# registerView rich views, the frozen status-line seam) only in Chat; this patch also draws them on
# the Launchpad, above the input card, so the usage line is there from the first screen.
# installCheck renders the real patched Launchpad through dsh-TUI's own ink (DSH_TUI_TYPES).
{ }:
{
  name = "dsh-usage-limits";
  patches = [ ../patches/dsh-tui-0.15.0-launchpad-status.patch ];
  postPatch = "";
  installCheck = "node --test ${../test/tui-patch}/*.test.mjs";
}
