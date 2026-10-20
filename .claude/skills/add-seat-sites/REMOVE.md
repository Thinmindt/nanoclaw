# Remove add-seat-sites

Run from the NanoClaw project root. Safe to re-run.

## 1. Take the rules out

```bash
pnpm exec tsx .claude/skills/add-seat-sites/scripts/seat-sites.ts --remove
```

This deletes every rule named `Seat sites: ...`, publishes, and checks that no other rule
changed. The seats are back to whatever their other rules allow.

## 2. Delete the list and the skill

`data/seat-sites.json` is the operator's; delete it by hand. Then
`rm -rf .claude/skills/add-seat-sites`. Nothing else in the tree changed.
