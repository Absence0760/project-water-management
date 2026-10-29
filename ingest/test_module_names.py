"""No module of ours shadows a package the image installs, or the stdlib.

The image copies our modules flat into /var/task, which is first on the
Lambda's sys.path, so a file named like an installed top-level package wins
the import. `ecmwf.py` (the ECMWF forecast job, now ecmwf_forecast.py) did
exactly that to ecmwf-datastores-client's `ecmwf` namespace package: every
CDS-backed run (era5l, agera5_et0, c3s) failed in production on
`from ecmwf.datastores import Client` (cdsjob.LiveCds) with "'ecmwf' is not a
package", while the fixture-mode tests, which never build the real client,
stayed green.

    ingest/.venv/bin/python -m unittest test_module_names
"""

import importlib.metadata
import importlib.util
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _our_modules() -> dict[str, Path]:
    """Every top-level name our code can be imported as: ingest/*.py, the
    fixture helpers the tests put on sys.path (fixtures/*.py and
    fixtures/<product>/*.py), and any regular package in those directories."""
    out: dict[str, Path] = {}
    for d in [HERE, HERE / "fixtures", *sorted(p for p in (HERE / "fixtures").iterdir() if p.is_dir())]:
        for f in d.glob("*.py"):
            out[f.stem] = f
        for p in d.iterdir():
            if p.is_dir() and (p / "__init__.py").exists():
                out[p.name] = p
    return out


def _required_dists() -> list[str]:
    names = re.findall(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==", (HERE / "requirements.txt").read_text(), re.M)
    return [re.sub(r"[-_.]+", "-", n).lower() for n in names]


def _installed_top_levels() -> dict[str, set[str]]:
    """Top-level import name -> the installed distributions providing it."""
    out: dict[str, set[str]] = {}
    for top, dists in importlib.metadata.packages_distributions().items():
        for d in dists:
            out.setdefault(top, set()).add(re.sub(r"[-_.]+", "-", d).lower())
    return out


def _image_files() -> list[str]:
    return [f for ln in (HERE / "Dockerfile").read_text().splitlines() if ln.startswith("COPY ") for f in re.findall(r"(\S+\.py)", ln)]


def _datastores_installed() -> bool:
    try:
        importlib.metadata.distribution("ecmwf-datastores-client")
    except importlib.metadata.PackageNotFoundError:
        return False
    return True


class ModuleNames(unittest.TestCase):
    def test_no_module_is_named_ecmwf(self):
        """The production failure itself: ecmwf-datastores-client's package."""
        self.assertNotIn("ecmwf", _our_modules())

    def test_no_module_shares_a_name_with_an_installed_requirement(self):
        required = set(_required_dists())
        tops = _installed_top_levels()
        clashes = {name: sorted(tops[name] & required) for name in _our_modules() if tops.get(name, set()) & required}
        self.assertEqual(clashes, {}, "rename these modules: an installed requirement owns the name")

    def test_no_module_shares_a_name_with_the_stdlib(self):
        clashes = sorted(set(_our_modules()) & set(sys.stdlib_module_names))
        self.assertEqual(clashes, [])

    def test_the_check_sees_the_requirements_top_levels(self):
        """Control: the clash check above would find a clash, so its silence
        means something. Skipped where the venv lacks the client."""
        if not _datastores_installed():
            self.skipTest("ecmwf-datastores-client is not installed")
        self.assertIn("ecmwf-datastores-client", _installed_top_levels().get("ecmwf", set()))
        self.assertIn("ecmwf-datastores-client", _required_dists())


class AsTheImageImports(unittest.TestCase):
    """Our modules laid out flat as the image's COPY line lays them out, first
    on sys.path as /var/task is in the Lambda."""

    def _run(self, code: str) -> subprocess.CompletedProcess:
        with tempfile.TemporaryDirectory() as tmp:
            for f in _image_files():
                shutil.copy(HERE / f, tmp)
            # `python -c` puts the working directory first on sys.path.
            return subprocess.run([sys.executable, "-c", code], cwd=tmp, capture_output=True, text=True)

    def test_import_ecmwf_is_not_ours(self):
        p = self._run(
            "import importlib.util, os\n"
            "s = importlib.util.find_spec('ecmwf')\n"
            "here = os.path.realpath(os.getcwd())\n"
            "assert s is None or not any(os.path.realpath(x).startswith(here) for x in [*([s.origin] if s.origin else []), *(s.submodule_search_locations or [])]), s\n"
        )
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_the_cds_client_resolves_beside_our_modules(self):
        if not _datastores_installed():
            self.skipTest("ecmwf-datastores-client is not installed")
        p = self._run(
            "import importlib.util\n"
            "assert importlib.util.find_spec('ecmwf.datastores') is not None\n"
            "from ecmwf.datastores import Client\n"
            "import cdsjob, lambda_handler, ecmwf_forecast\n"
        )
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_the_control_fails_with_a_shadowing_module(self):
        """Control: an `ecmwf.py` beside our modules breaks the import the way
        production broke, so the test above would have caught it."""
        if not _datastores_installed():
            self.skipTest("ecmwf-datastores-client is not installed")
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "ecmwf.py").write_text("")
            p = subprocess.run([sys.executable, "-c", "from ecmwf.datastores import Client"], cwd=tmp, capture_output=True, text=True)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("'ecmwf' is not a package", p.stderr)


if __name__ == "__main__":
    unittest.main()
