"""Run the pinned upstream grader on synthetic logs, without executing a candidate."""
import json
from pathlib import Path
import sys

upstream, directory, prediction_file = map(Path, sys.argv[1:])
sys.path.insert(0, str(upstream))
from swebench.harness.constants import START_TEST_OUTPUT, END_TEST_OUTPUT, TEST_EXIT_CODE
from swebench.harness.grading import get_eval_report
from swebench.types import TestSpec

prediction = json.loads(prediction_file.read_text())
spec = TestSpec(
    instance_id=prediction["instance_id"], image="unused", eval_script_list=[],
    repo="example/repo", version="fixture", FAIL_TO_PASS=["test_fix"],
    PASS_TO_PASS=["test_stable"], log_parser="parse_log_pytest",
    eval_type="pass_and_fail",
)
cases = [
    ("resolved", "PASSED test_fix\nPASSED test_stable", 0, "resolved"),
    ("unfixed", "FAILED test_fix\nPASSED test_stable", 1, "unresolved"),
    ("regression", "PASSED test_fix\nFAILED test_stable", 1, "unresolved"),
    ("skipped_fix", "SKIPPED test_fix\nPASSED test_stable", 0, "unresolved"),
    ("skipped_stable", "PASSED test_fix\nSKIPPED test_stable", 0, "resolved"),
    ("missing_fix", "PASSED test_stable", 0, "unresolved"),
    ("false_success", "PASSED test_fix\nPASSED test_stable", 1, "unresolved"),
    ("no_tests", "", 0, "unresolved"),
    ("environment", "Cannot allocate memory", 1, "infrastructure_failure"),
]
results = []
for name, body, exit_code, expected in cases:
    log = directory / f"{name}.log"
    log.write_text(f"{START_TEST_OUTPUT}\n{body}\n{END_TEST_OUTPUT}\n{TEST_EXIT_CODE}: {exit_code}\n")
    report = get_eval_report(spec, prediction, str(log), include_tests_status=True)
    results.append({"name": name, "expected": expected, "report": report})
print(json.dumps(results))
