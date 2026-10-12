{ lib, buildNpmPackage, fetchurl, jq, runCommand, nodejs }:

# dsh-TUI 0.14.0 exactly as nix-config builds it (pkgs/dsh-tui.nix at nix-config 6a7e613: same
# tarball hash, manifest edits, package-lock.json and npmDepsHash), with only this plugin's
# launchpad-status patch applied. The fleet's dst also carries other plugins' patches (word edit,
# omp keys, model selector, schedule deny, speed); those do not touch the status block. Copies:
# nix/dsh-tui/package-lock.json and nix/dsh-tui/launchpad-status.test.mjs from nix-config 6a7e613.
let
  version = "0.14.0";
  tarball = fetchurl {
    url = "https://registry.npmjs.org/@deepseek-harness-tui/dsh-tui/-/dsh-tui-${version}.tgz";
    hash = "sha512-syU0CLbAoxA97URyhnPFiLbWm3dXrmCR5NCO6mFovRi7mebX2HeEYdhpugEoT9vZ1vpUfE/+uX7xrs6zOGUJ1g==";
  };
  unlistedPeers = [
    "@deepseek-ai/cordis-plugin-include"
    "@deepseek-ai/dsh-agent-preset"
    "@deepseek-ai/dsh-attachment-local"
    "@deepseek-ai/dsh-mcp-client"
    "@deepseek-ai/dsh-session-persistence"
    "@deepseek-ai/dsh-session-persistence-jsonl"
  ];
  src = runCommand "dsh-tui-source-${version}" { nativeBuildInputs = [ jq ]; } ''
    mkdir -p $out
    tar -xzf ${tarball} -C $out --strip-components=1
    jq --argjson names '${builtins.toJSON unlistedPeers}' '
      .peerDependencies += ($names | map({ key: ., value: "*" }) | from_entries)
      | .peerDependenciesMeta += ($names | map({ key: ., value: { optional: true } }) | from_entries)' \
      $out/package.json > $out/package.json.runtime
    jq 'del(.devDependencies, .scripts, .bundledDependencies, .peerDependencies, .peerDependenciesMeta)
      | .optionalDependencies |= with_entries(select(.key | startswith("@dsh-") | not))' \
      $out/package.json.runtime > $out/package.json
    mv $out/node_modules $out/bundled
    cp ${./dsh-tui/package-lock.json} $out/package-lock.json
  '';
in
buildNpmPackage {
  pname = "dsh-tui";
  inherit version src;

  patches = [ ../patches/dsh-tui-0.14.0-launchpad-status.patch ];

  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-EMVmgJJ3sc0iqN+vmW/t6vWtrQWANc50biq6h15XfpA=";
  npmFlags = [ "--legacy-peer-deps" "--ignore-scripts" ];
  dontNpmBuild = true;

  postInstall = ''
    pkg=$out/lib/node_modules/@deepseek-harness-tui/dsh-tui
    cp -r bundled/. $pkg/node_modules/
    cp package.json.runtime $pkg/package.json
    rm -r $out/bin
  '';

  doInstallCheck = true;
  nativeInstallCheckInputs = [ nodejs ];
  installCheckPhase = ''
    runHook preInstallCheck
    HOME=$TMPDIR DSH_TUI_TYPES=$out/lib/node_modules/@deepseek-harness-tui/dsh-tui/lib/types \
      node --test ${./dsh-tui/launchpad-status.test.mjs}
    runHook postInstallCheck
  '';

  meta.description = "dsh-TUI 0.14.0 with the dsh-usage-limits Launchpad status patch (test pin)";
}
