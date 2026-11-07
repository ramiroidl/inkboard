import type { CalendarStatus } from "@inkboard/contracts";

export function CalendarSettings({ status }: { status: CalendarStatus }) {
  return (
    <p className="hint">
      {status.homeAssistantConfigured
        ? "Home Assistant is connected. Choose calendars in each Calendar agenda or Month calendar widget."
        : "Set INKBOARD_HOME_ASSISTANT_URL and INKBOARD_HOME_ASSISTANT_TOKEN to connect Home Assistant."}
    </p>
  );
}
