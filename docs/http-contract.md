# Internal HTTP contract (2026-10-22)

All JSON; no-store; errors {error:{code,message,current?},requestId}; mutations require Origin and X-CSRF-Token from authenticated bootstrap, plus Idempotency-Key on commands/messages. Resident cookies HttpOnly SameSite Lax so the authenticated Ring OAuth redirect works; guest cookies SameSite Strict. All mutations retain Origin+CSRF checks. Local demo identity selection is explicit.
POST /api/auth/demo {identity:alex|sam|jordan} -> resident cookie, {csrf,user}; GET /api/me -> Bootstrap; POST /api/auth/logout.
GET /api/visits/:id?cursor= -> VisitView; POST /api/visits/:id/commands -> VisitCommand, {visit}.
POST /api/demo/press {scenario?:string} -> {visit}; fixture caption trigger POST /api/demo/captions {visitId}; POST /api/demo/media-expire {visitId}.
POST /api/guest/sessions {publicDoorId} -> guest cookie, GuestView; GET /api/guest -> GuestView; POST /api/guest/messages {text,category}; POST /api/guest/messages/:id/display or /confirm -> explicit delivery stage. Guest actor selected only from guest cookie even in resident browser.
POST /api/settings -> SettingsInput; POST /api/settings/unlink; POST /api/members/:id/revoke. GET /api/sign/:publicDoorId -> neutral printable HTML + real QR.
GET /api/health -> real DB check; POST /api/ring/webhook -> exact raw-body signature validation before parsing. GET /api/ring/connect and /callback use resident session.
Worker ws://127.0.0.1:3411/ws authenticates HttpOnly cookie and Origin at upgrade; first message {type:subscribe,visitId} or {type:guest}; ephemeral event {type:changed,eventId,visitId,version} causes strong refetch; {type:caption,caption} uses mediaSessionId+resultId partial replacement. Capture is {type:capture,visitId,leaseId,mediaSessionId} then binary frames.
