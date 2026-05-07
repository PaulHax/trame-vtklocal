"""End-to-end Playwright oracle for push-sync.

The companion in-process oracle (``tests/push_oracle/``) verifies that
``PushSync``'s server-side patch generation is internally consistent. This
package drives the full production stack — real wslink, real
``createPushSync``, real ``synchronizePreparedStateSync`` — and compares the
client's reconstructed scene against a fresh server shadow snapshot after
each oracle step.
"""
