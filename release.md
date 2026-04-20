## What's new

- Replace manual file-copy checkpoint system with a shadow git repo (.ag/shadow-git/) that captures the entire working tree at each checkpoint — closes the bash blind spot where npm install, sed, build scripts, etc. produced zero backups
- Add session ID (8-char hex) shown in token footer and checkpoint listings for
cross-session context
- Show turn number in REPL prompt ([turn N] you>) so users can correlate with checkpoint/rewind listings
- /checkpoint now lists by default; /checkpoint create [label] to create
- Rewind properly resets turn counter, prunes stale summaries, and removes consumed checkpoints
- /memory clear reinitializes shadow git instead of leaving a broken reference