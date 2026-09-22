# Lessons

- 2026-09-14: Integration tests run against a retained local database. Use unique names for constrained fixture rows, and compare error counts within the actual hourly aggregation bucket. A fixed season name and an old error bucket caused repeat runs to fail even though the backend and migrations were current; resetting the database would hide those test defects.
- 2026-09-14: Event-copy tests must save the inferred source format unchanged and compare persisted tee groups. Switching to individual gross before saving hid the format-copy regression; renaming a team must preserve grouping when its membership has not changed.
