const TEAMMATE_ID_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

export function isValidTeammateId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    TEAMMATE_ID_RE.test(id) &&
    !id.includes("..")
  );
}
