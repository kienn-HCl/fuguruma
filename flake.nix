{
  description = "Fuguruma (文車): a self-hosted ebook reader";

  # The channel tarball is the same nixos-unstable as github:NixOS/nixpkgs/nixos-unstable,
  # but is smaller to download and is served from the NixOS cache infrastructure.
  inputs.nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.xz";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        # x86_64-darwin is no longer supported by nixpkgs (26.11+).
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      version = "unstable-${self.shortRev or self.dirtyShortRev or "dev"}";
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          inherit (pkgs) lib;

          # The web UI (web/dist), built from web/package-lock.json.
          web = pkgs.buildNpmPackage {
            pname = "fuguruma-web";
            inherit version;
            src = ./web;
            nodejs = pkgs.nodejs_22;
            # Fetch every package from the lock file's integrity hashes, so no
            # npmDepsHash has to be updated when dependencies change.
            npmDeps = pkgs.importNpmLock { npmRoot = ./web; };
            npmConfigHook = pkgs.importNpmLock.npmConfigHook;
            installPhase = ''
              runHook preInstall
              cp -r dist $out
              runHook postInstall
            '';
          };

          fuguruma = pkgs.buildGoModule {
            pname = "fuguruma";
            inherit version;
            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./go.mod
                ./go.sum
                ./cmd
                ./internal
                ./web/embed.go
                ./web/dist/.gitkeep
              ];
            };
            # Update after changing go.mod/go.sum: set to lib.fakeHash, run
            # `nix build`, and copy the hash from the error message.
            vendorHash = "sha256-Lj0qsRUUnvyCU5ZbsWVVysOjB0MEzvpXeTiByaJiwtM=";
            subPackages = [ "cmd/fuguruma" ];
            env.CGO_ENABLED = 0;
            ldflags = [
              "-s"
              "-w"
              "-X main.version=${version}"
            ];
            # go:embed picks up the web UI from web/dist.
            preBuild = ''
              rm -rf web/dist
              cp -r ${web} web/dist
              chmod -R u+w web/dist
            '';
            passthru = { inherit web; };
            meta = {
              description = "Self-hosted ebook reader with highlights, notes and AI conversations";
              homepage = "https://github.com/kienn-HCl/fuguruma";
              license = lib.licenses.mit;
              mainProgram = "fuguruma";
            };
          };
        in
        {
          inherit fuguruma web;
          default = fuguruma;
        }
      );

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            go
            gopls
            gotools # goimports etc.
            govulncheck
            goreleaser
            nodejs_22
            gnumake
            git
          ];
        };
      });

      checks = forAllSystems (pkgs: {
        build = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
