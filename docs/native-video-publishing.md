# Native Library video publishing

Provider contracts checked against official documentation on 2026-10-04:

- https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
- https://developers.facebook.com/documentation/video-api/guides/reels-publishing.md
- https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
- https://developers.google.com/youtube/v3/docs/videos/insert

Instagram uses REELS containers, waits for FINISHED, then publishes and confirms the exact container/media. Facebook explicitly uses the Page Reels start/upload/finish API, not feed text or photo publishing. Its supported subset is portrait 9:16, at least 540×960, 3–90 seconds, 24–60 fps. Instagram supports 3–900 seconds, 23–60 fps. This application caps all native uploads at 300 MB MP4 H.264/HEVC; it does not promise every file permitted by a provider.

Meta requires app review/advanced access for relevant permissions for users outside app roles, a Page with CREATE_CONTENT/MANAGE authorization, and an Instagram professional account. Page publishing authorization and two-factor requirements may also apply. Scope inspection is fail-closed for native uploads.

YouTube requests readonly plus youtube.upload; legacy connections must reconnect. Google OAuth consent verification and YouTube API audit are separate approvals. videos.insert uploads from unaudited API projects created after July 28, 2020 may be restricted to private viewing. Requested visibility is not a guarantee; final visibility discrepancies are reported. Square/vertical videos up to three minutes may qualify as Shorts, but YouTube controls classification.

Uploads freeze reviewed metadata. Resumable sessions are encrypted, never returned to clients. Provider response loss leaves durable create/commit checkpoints; ambiguous creates do not automatically repeat. YouTube resumes from the server-reported byte range, and Meta polls exact identifiers. A successful transfer is processing, not published. Attention states require checking the platform before creating another Library item.

No live publishing is part of automated verification. Production app approval and an explicitly authorized test upload remain owner-controlled operations.