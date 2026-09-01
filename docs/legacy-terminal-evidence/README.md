# Archived local terminal WIP

These files preserve the pre-existing, uncommitted LOFA terminal work that was
present when the single-frontend migration began. They are evidence only:

- they are outside `app/www` and are not packaged into the APK;
- they are outside `tools/test/web` and are not part of the active test suite;
- imports still describe the former runtime layout and are intentionally not a
  supported build target.

The live terminal experience is owned by Dashboard and reaches Android through
the declared LOFA native bridge.
