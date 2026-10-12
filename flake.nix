{
  description = "dsh-usage-limits: Claude and Codex plan usage for DeepSeek Harness (dst line, web ring)";

  inputs = {
    # Same nixpkgs and nix-dsh revisions as nix-config 6a7e613's flake.lock, so dsh and dsh-TUI
    # build exactly as on the fleet.
    nixpkgs.url = "github:NixOS/nixpkgs/7fc6f2c20af09cdcaf48b92ec3121860139ec668";
    # Tools: beads 1.3.0 and playwright-driver 1.63.0 (the npm playwright pin matches it).
    nixpkgs-tools.url = "github:NixOS/nixpkgs/b6c8664de9b6cc07fe5666a29f91884ba81197c4";
    nix-dsh = {
      url = "github:jakehemmerle/nix-dsh/f0ca0d745df8cbe99bad91d59153dbd690ae6660";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, nixpkgs-tools, nix-dsh }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f {
        inherit system;
        pkgs = nixpkgs.legacyPackages.${system};
        tools = nixpkgs-tools.legacyPackages.${system};
      });

      per = { system, pkgs, tools }: rec {
        version = (pkgs.lib.importJSON ./package.json).version;
        nodejs = pkgs.nodejs_24;

        # dsh 0.2.1-alpha.2, built the way nix-config builds dshBase.
        dsh = pkgs.callPackage "${nix-dsh}/package.nix" { };
        dshScope = "${dsh}/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";
        dshTui = pkgs.callPackage ./nix/dsh-tui.nix { inherit nodejs; };
        dshTuiDir = "${dshTui}/lib/node_modules/@deepseek-harness-tui/dsh-tui";
        browsers = tools.playwright-driver.browsers;

        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            ./index.js ./client.js ./tui.js ./lib ./package.json ./package-lock.json
            ./cordis.patch.yml ./test ./scripts ./patches ./SPEC.md ./TESTING.md
          ];
        };

        nodeModules = pkgs.importNpmLock.buildNodeModules {
          npmRoot = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [ ./package.json ./package-lock.json ];
          };
          inherit nodejs;
          derivationArgs.npmFlags = [ "--ignore-scripts" ];
        };

        package = pkgs.stdenvNoCC.mkDerivation {
          pname = "dsh-usage-limits";
          inherit version src;
          dontConfigure = true;
          dontBuild = true;
          doCheck = true;
          nativeCheckInputs = [ nodejs ];
          checkPhase = ''
            runHook preCheck
            HOME=$TMPDIR node --test test/smoke.test.js
            runHook postCheck
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp -r index.js client.js tui.js lib package.json cordis.patch.yml $out/
            runHook postInstall
          '';
          meta.description = "Claude and Codex plan usage for DeepSeek Harness: dst line and web meter";
        };

        # Fast suites (properties, host runtime, contract) in the build sandbox against the pinned
        # dsh scope and the patched dsh-TUI.
        fast = pkgs.runCommand "dsh-usage-limits-fast-tests" {
          # jq: the cmux-usage parity oracle shells out to it (like /usr/bin/env, absent from the sandbox).
          nativeBuildInputs = [ nodejs pkgs.diffutils pkgs.jq ];
          NUM_RUNS = "1000";
        } ''
          cp -r ${src} work && chmod -R u+w work && cd work
          # The sandbox has no /usr/bin/env (cmux-usage's shebang); the repo copy stays verbatim.
          patchShebangs test/oracle/cmux-usage
          ln -s ${nodeModules}/node_modules node_modules
          export HOME=$TMPDIR DSH_SCOPE_DIR=${dshScope} DSH_TUI_DIR=${dshTuiDir}
          node scripts/link-host.mjs
          NODE_ENV=test node --preserve-symlinks --test test/*.test.js 2>&1 | tee $TMPDIR/log
          grep -Eq '^ℹ fail 0$' $TMPDIR/log
          grep -Eq '^ℹ skipped 0$' $TMPDIR/log
          cp $TMPDIR/log $out
        '';

        envVars = {
          DSH_BIN = "${dsh}/bin/dsh";
          DSH_SCOPE_DIR = dshScope;
          DSH_TUI_DIR = dshTuiDir;
          PLAYWRIGHT_BROWSERS_PATH = "${browsers}";
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
        };

        e2e = pkgs.writeShellApplication {
          name = "dsh-usage-limits-e2e";
          runtimeInputs = [ nodejs pkgs.tmux dsh pkgs.coreutils pkgs.gnugrep pkgs.diffutils ];
          text = ''
            # Real-client suites: dst (dsh-TUI in a private tmux socket) and dsh web (Playwright).
            # Run from the repo checkout. E2E_RUNS / FC_SEED (or SEED) / FC_PATH control fast-check.
            ${pkgs.lib.concatStringsSep "\n" (pkgs.lib.mapAttrsToList (k: v: "export ${k}=${pkgs.lib.escapeShellArg v}") envVars)}
            root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
            cd "$root"
            [ -f package.json ] && grep -q '"@local/dsh-usage-limits"' package.json || { echo "run from the dsh-usage-limits checkout" >&2; exit 2; }
            [ -e node_modules ] || ln -s ${nodeModules}/node_modules node_modules
            echo "dsh $(dsh --version); dsh-TUI $DSH_TUI_DIR"
            status=0
            suites=("$@"); [ "${"$"}{#suites[@]}" -gt 0 ] || suites=(tui web)
            for s in "${"$"}{suites[@]}"; do
              NODE_ENV=test node --test --test-concurrency=1 --test-timeout=21600000 "test/e2e/$s.e2e.test.js" || status=$?
            done
            exit "$status"
          '';
        };
      };
    in {
      packages = forAll (a: let p = per a; in {
        default = p.package;
        dsh-tui = p.dshTui;
        dsh = p.dsh;
        e2e = p.e2e;
      });

      checks = forAll (a: let p = per a; in {
        package = p.package;
        fast = p.fast;
        dsh-tui = p.dshTui;
      });

      apps = forAll (a: let p = per a; in {
        e2e = { type = "app"; program = "${p.e2e}/bin/dsh-usage-limits-e2e"; };
      });

      devShells = forAll (a: let p = per a; in {
        default = a.pkgs.mkShell ({
          packages = [ p.nodejs a.pkgs.tmux p.dsh a.tools.beads a.pkgs.git ];
          shellHook = ''
            echo "dsh-usage-limits dev shell: dsh $(dsh --version 2>/dev/null), dsh-TUI 0.14.0+launchpad-status, playwright browsers ${p.browsers}"
          '';
        } // p.envVars);
      });
    };
}
