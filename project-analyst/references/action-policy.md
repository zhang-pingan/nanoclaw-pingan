# Proposed Action Policy

The only allowed action names are:

- `create_work_item`
- `open_discussion`
- `post_progress`
- `watch_work_item`
- `request_information`
- `publish_analysis_report`

Actions are proposals only. Do not include Host URLs, shell commands, Git commits, projection patches, credentials, membership changes, permission changes, client changes, or group lifecycle changes. Icarus revalidates edited parameters, current permissions, verified head, revisions, and Git CAS after a user explicitly confirms each action.
