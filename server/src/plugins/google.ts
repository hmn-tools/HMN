import type { ParsedEvent } from "./calendar";

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export function googleAuthURL(clientId: string, redirect: string, state: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGoogleCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirect: string;
  fetchImpl?: typeof fetch;
}): Promise<{ refresh_token?: string; access_token?: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirect,
    grant_type: "authorization_code",
  });
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error("Google did not return a token.");
  return (await response.json()) as { refresh_token?: string; access_token?: string };
}

export async function refreshGoogleAccess(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "refresh_token",
  });
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error("Google did not refresh the token.");
  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Google did not refresh the token.");
  return json.access_token;
}

export function eventsFromGooglePayload(payload: { items?: Array<Record<string, unknown>> }): ParsedEvent[] {
  const items = payload.items ?? [];
  return items.flatMap((item) => {
    const start = item.start as { date?: string; dateTime?: string } | undefined;
    const uid = typeof item.id === "string" ? item.id : "";
    const title = typeof item.summary === "string" ? item.summary : "";
    if (!uid || !title || !start) return [];
    const allDay = typeof start.date === "string";
    const due = allDay ? start.date! : start.dateTime!;
    const attendees = Array.isArray(item.attendees)
      ? item.attendees.map((person) => {
          const row = person as { displayName?: string; email?: string };
          return row.displayName || row.email || "";
        }).filter(Boolean)
      : [];
    return [{ uid, title, due, allDay, description: typeof item.description === "string" ? item.description : null, attendees }];
  });
}

export async function listGoogleEvents(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<ParsedEvent[]> {
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeMin", new Date().toISOString());
  url.searchParams.set("maxResults", "20");
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error("Google Calendar did not answer.");
  return eventsFromGooglePayload((await response.json()) as { items?: Array<Record<string, unknown>> });
}
