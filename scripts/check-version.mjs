#!/usr/bin/env node
/**
 * Un seul tag versionne les DEUX packages.
 *
 * `package.json`, `python/pyproject.toml`, `src/index.ts` et `src/cli.ts`
 * doivent porter le même numéro — et, si `GITHUB_REF` désigne un tag `v*`, ce
 * tag aussi. Sans ce garde-fou, un `npm version` sans `uv version` publierait
 * deux packages qui se disent la même version sans l'être : le pire cas
 * possible pour quelqu'un qui débogue une installation depuis git.
 *
 *   node scripts/check-version.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function lire(chemin) {
  return readFileSync(join(ROOT, chemin), "utf8");
}

const sources = [];

sources.push({
  nom: "package.json",
  version: JSON.parse(lire("package.json")).version,
});

const pyproject = lire("python/pyproject.toml");
sources.push({
  nom: "python/pyproject.toml",
  version: pyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
});

sources.push({
  nom: "src/index.ts",
  version: lire("src/index.ts").match(/export const VERSION = "([^"]+)"/)?.[1],
});

sources.push({
  nom: "src/cli.ts",
  version: lire("src/cli.ts").match(/const VERSION = "([^"]+)"/)?.[1],
});

sources.push({
  nom: "python/src/providall/__init__.py",
  version: lire("python/src/providall/__init__.py").match(/__version__ = "([^"]+)"/)?.[1],
});

// Sur un tag `v1.2.3`, il doit correspondre. En dehors, on ne vérifie que la
// cohérence interne — un commit de développement n'a pas de tag.
const ref = process.env.GITHUB_REF ?? "";
if (ref.startsWith("refs/tags/v")) {
  sources.push({ nom: "tag git", version: ref.slice("refs/tags/v".length) });
}

const manquantes = sources.filter((s) => !s.version);
if (manquantes.length) {
  console.error("version introuvable dans :\n  " + manquantes.map((s) => s.nom).join("\n  "));
  process.exit(1);
}

const distinctes = new Set(sources.map((s) => s.version));
if (distinctes.size > 1) {
  console.error("versions divergentes :");
  for (const s of sources) console.error(`  ${s.version.padEnd(12)} ${s.nom}`);
  console.error(
    "\nProcédure : npm version X.Y.Z --no-git-tag-version, " +
      "puis `uv version X.Y.Z` dans python/, puis mettre à jour VERSION/__version__.",
  );
  process.exit(1);
}

console.log(`version cohérente : ${sources[0].version} (${sources.length} sources)`);
