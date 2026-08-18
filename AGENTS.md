## Summary

- **Dashboard slow loading**: Fixed by caching `scanChaptersDirectory` results on backend (2s TTL) and showing UI immediately after registry loads instead of waiting for all detail fetches
- **Dashboard not opening**: Same fix - early `setLoading(false)` lets the UI render while details stream in
- **Logo**: Added inline SVG favicon (data URI) and header logo icon in NovelTabs component

## Folder restructure

- **`server.ts` → `server/index.ts`**: Main server entry moved into `server/` directory; all imports updated (`./server/core/` → `./core/`); `package.json` dev/build scripts, `.bat`/`.ps1` start scripts updated
- **`data/` cleaned**: Removed stale test/import folders (sinners-world, my-great-novel, test-novel, test-test, view, income, scripts, chapters, Sinner's World, Fang Yuan, AniScout, Mayuri); old Python projects moved to `legacy/`; `validate_chapters.py` → `scripts/`
- **`clean_patreon_posts.ts` → `scripts/`**: Moved from root, fixed imports
- **`workspace/` removed**: Empty novel registry, old Python artifact
- **`logs/` consolidated**: Removed scattered `logs/` dirs in server/src/scripts/tests/electron/workspace/assets/build/shared; centralized to `/logs`
- **Root cleanup**: Removed zero-byte placeholders, moved probe/debug scripts to `scripts/`, moved start scripts, moved stale `novels.yaml` and sensitive patreon data to `legacy/`
- **`data/novels.yaml`**: Added Lord of Mysteries : Fang Yuan (slug: `35831534400046105`) to registry; created `data/35831534400046105/` dir structure

## Performance changes

- `server/core/parser.ts`: Added `chapterCache` Map with 2s TTL, exported `invalidateChapterCache()` for mutation endpoints
- `server/api/v1.ts`: All `scanChaptersDirectory` calls now pass slug for caching; chapter create/update/delete/upload/lock/unlock invalidate cache
- `src/App.tsx`: `fetchNovels` now sets `loading=false` right after registry data, details load in background; added 30s cache for `loadNovelDetails` to skip redundant network calls on tab switches
