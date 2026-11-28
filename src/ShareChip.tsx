// The Share button above a document: who can open it, in a few words, and
// the way into the Share dialog. Shown for a document in My files or in
// something shared — where sharing is done. A document in Library is
// everyone's already, and one in no section syncs nowhere: neither has one.

import { audienceLine, placeOf, type CloudStatus } from "./cloud";

export default function ShareChip({ cloud, rel, onShare }: { cloud: CloudStatus; rel: string; onShare: () => void }) {
  const place = placeOf(cloud, rel);
  if (place.kind !== "mine" && place.kind !== "share") return null;
  const who = audienceLine(cloud, place);
  const alone = place.kind === "mine";
  return (
    <button
      className={`live-chip is-publish share-chip ${alone ? "" : "is-shared"}`}
      data-testid="share-chip"
      title={alone ? "Only you can open this. Share it…" : `${who} can open this. Share it with more people…`}
      onClick={onShare}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
        <circle cx="17.5" cy="9" r="2.5" />
        <path d="M17.5 14.5a4.5 4.5 0 0 1 4 5" />
      </svg>
      {alone ? "Share" : who}
    </button>
  );
}
