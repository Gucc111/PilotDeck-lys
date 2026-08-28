type SessionPresentationInput = {
  sessionId: string;
  summary?: string;
  firstPrompt?: string;
  tag?: string;
};

export type LegacySessionPresentation = {
  title: string;
  summary: string;
  name: string;
  tag?: string;
};

const CRON_SESSION_PREFIX = "cron:";
const CRON_TITLE_PREFIX = "[Cron] ";

const TEAMMATE_SESSION_INFIX = "::teammate::";
const DELEGATION_INFIX = "::delegation::";

export type ParsedTeammateSessionId = {
  leaderSessionId: string;
  teammateId: string;
};

export function parseTeammateSessionId(sessionId: string): ParsedTeammateSessionId | null {
  const teammateIndex = sessionId.indexOf(TEAMMATE_SESSION_INFIX);
  if (teammateIndex === -1) return null;

  const leaderSessionId = sessionId.slice(0, teammateIndex);
  let teammateId = sessionId.slice(teammateIndex + TEAMMATE_SESSION_INFIX.length);

  const delegationIndex = teammateId.indexOf(DELEGATION_INFIX);
  if (delegationIndex !== -1) {
    teammateId = teammateId.slice(0, delegationIndex);
  }

  return { leaderSessionId, teammateId };
}

export function mapLegacySessionPresentation(
  session: SessionPresentationInput,
): LegacySessionPresentation {
  const baseLabel = session.summary || session.firstPrompt || session.sessionId;
  const isCronSession = session.sessionId.startsWith(CRON_SESSION_PREFIX);
  const parsedTeammate = parseTeammateSessionId(session.sessionId);

  let label: string;
  if (isCronSession && !baseLabel.startsWith(CRON_TITLE_PREFIX)) {
    label = `${CRON_TITLE_PREFIX}${baseLabel}`;
  } else if (parsedTeammate) {
    const prefix = `[${parsedTeammate.teammateId}] `;
    label = baseLabel.startsWith(prefix) ? baseLabel : `${prefix}${baseLabel}`;
  } else {
    label = baseLabel;
  }

  let tag: string | undefined;
  if (session.tag) {
    tag = session.tag;
  } else if (isCronSession) {
    tag = "cron";
  } else if (parsedTeammate) {
    tag = "teammate";
  }

  return {
    title: label,
    summary: label,
    name: label,
    tag,
  };
}
