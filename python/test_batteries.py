"""Unit tests for batteries.run_cli.

Stdlib unittest — no pytest dependency. Run with:
    python3 -m unittest python/test_batteries.py

These tests cover the three behaviors that matter for the RTK integration:
  1. Auto-prefix `rtk` when _RLMX_RTK_MODE=on
  2. Skip auto-prefix when the command is already `rtk` (avoids `rtk rtk gain`)
  3. Pass through unchanged when _RLMX_RTK_MODE=off
  4. Timeout + FileNotFoundError paths return structured dicts rather than raising
"""

import os
import stat
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

# Make `batteries` importable when this file runs directly.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from batteries import run_cli  # noqa: E402


class RunCliAutoPrefixTest(unittest.TestCase):
    """Exercise run_cli's auto-prefix decision logic with a stubbed rtk."""

    def setUp(self) -> None:
        # Workspace with a fake `rtk` shim that echoes its own argv so we
        # can assert whether the prefix was applied.
        self.tmpdir = tempfile.mkdtemp(prefix="rlmx-run-cli-")
        self.stub_path = Path(self.tmpdir) / "rtk"
        # The stub prints its full argv so assertions can inspect what
        # run_cli actually invoked.
        self.stub_path.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import sys
                print("ARGV:" + "|".join(sys.argv))
                """
            )
        )
        self.stub_path.chmod(self.stub_path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        # Prepend the stub dir so our fake rtk wins over any real install.
        self._original_path = os.environ.get("PATH", "")
        os.environ["PATH"] = f"{self.tmpdir}:{self._original_path}"
        self._original_mode = os.environ.get("_RLMX_RTK_MODE")

    def tearDown(self) -> None:
        os.environ["PATH"] = self._original_path
        if self._original_mode is None:
            os.environ.pop("_RLMX_RTK_MODE", None)
        else:
            os.environ["_RLMX_RTK_MODE"] = self._original_mode
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_prefixes_rtk_when_mode_on(self) -> None:
        os.environ["_RLMX_RTK_MODE"] = "on"
        result = run_cli("echo-args", "hello")
        self.assertEqual(result["returncode"], 0)
        self.assertTrue(result["rtk_prefixed"], "expected rtk prefix when mode=on")
        # Stub rtk echoed its own argv → argv[0] is its path, argv[1..] is the forwarded command.
        self.assertIn("echo-args", result["stdout"])
        self.assertIn("|echo-args|hello", result["stdout"])

    def test_no_prefix_when_mode_off(self) -> None:
        os.environ["_RLMX_RTK_MODE"] = "off"
        # Run a real command that does not need rtk — `true` exits 0.
        result = run_cli("true")
        self.assertEqual(result["returncode"], 0)
        self.assertFalse(result["rtk_prefixed"], "rtk prefix must be skipped when mode=off")

    def test_skip_double_prefix_when_cmd_is_rtk(self) -> None:
        """`run_cli("rtk", "gain")` must NOT become `rtk rtk gain`."""
        os.environ["_RLMX_RTK_MODE"] = "on"
        result = run_cli("rtk", "gain")
        self.assertEqual(result["returncode"], 0)
        self.assertFalse(result["rtk_prefixed"], "cmd already `rtk` — must not double-prefix")
        # Stub echoed its own argv. Only ONE `rtk` token should appear in the
        # printed argv list (the stub itself); the passed-through "gain" must be present.
        argv_line = next(
            (line for line in result["stdout"].splitlines() if line.startswith("ARGV:")),
            "",
        )
        tokens = argv_line.split("|")
        rtk_tokens = [t for t in tokens if t.rstrip("/").endswith("rtk")]
        self.assertEqual(
            len(rtk_tokens),
            1,
            f"expected exactly one rtk token in argv, got: {tokens!r}",
        )
        self.assertIn("gain", tokens)

    def test_returns_structured_dict_shape(self) -> None:
        os.environ["_RLMX_RTK_MODE"] = "off"
        result = run_cli("true")
        self.assertIn("returncode", result)
        self.assertIn("stdout", result)
        self.assertIn("stderr", result)
        self.assertIn("rtk_prefixed", result)

    def test_timeout_returns_safe_dict(self) -> None:
        """A command that outlasts the timeout must not raise."""
        os.environ["_RLMX_RTK_MODE"] = "off"
        # `sleep 2` > timeout=0.1 → timeout branch should fire.
        result = run_cli("sleep", "2", timeout=0.1)
        self.assertEqual(result["returncode"], -1)
        self.assertIn("timeout", result["stderr"].lower())

    def test_missing_command_returns_safe_dict(self) -> None:
        os.environ["_RLMX_RTK_MODE"] = "off"
        result = run_cli("definitely-not-a-real-binary-xyz")
        self.assertEqual(result["returncode"], -1)
        self.assertIn("not found", result["stderr"].lower())


if __name__ == "__main__":
    unittest.main()
