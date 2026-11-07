import { useEffect, useId, useState } from "react";

import type {
  AdminEntitiesResponse,
  AdminTodoListsResponse,
  CustomScreen,
  CustomScreenInput,
  ScreenWidget,
  WidgetDescriptor,
  WidgetSettingSchema,
} from "@inkboard/contracts";

const MAX_WIDGETS = 12;

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    message?: string;
  } | null;
  return body?.message ?? body?.error ?? `${fallback} (${response.status})`;
}

function newWidget(descriptor: WidgetDescriptor): ScreenWidget {
  return { type: descriptor.type, ...structuredClone(descriptor.defaultConfig) };
}

function useSuggestions(source: WidgetSettingSchema["x-suggest"]) {
  const [options, setOptions] = useState<{ id: string; name: string; domain?: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (source !== "entity" && source !== "todo-list") {
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetch(
      source === "entity" ? "api/v1/admin/entities" : "api/v1/admin/microsoft-todo/lists",
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await readError(response, "Unable to load widget sources"));
        }
        if (source === "entity") {
          const body = (await response.json()) as AdminEntitiesResponse;
          setOptions(
            body.entities.map((entity) => ({
              id: entity.entityId,
              name: entity.name,
              domain: entity.domain,
            })),
          );
          setError(body.error);
        } else {
          const body = (await response.json()) as AdminTodoListsResponse;
          setOptions(body.available);
          setError(body.error);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Unable to load widget sources");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [source]);
  return { options, error, loading };
}

/** Renders one setting from the widget's JSON Schema. */
function SettingField({
  name,
  schema,
  value,
  onChange,
}: {
  name: string;
  schema: WidgetSettingSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const suggestionsId = useId();
  const suggestions = useSuggestions(schema["x-suggest"]);
  const suggestedOptions = suggestions.options.filter(
    (option) =>
      schema["x-domains"] === undefined ||
      (option.domain !== undefined && schema["x-domains"].includes(option.domain)),
  );
  const label = schema.title ?? name;
  const hint = schema.description ? <small className="hint">{schema.description}</small> : null;
  const placeholder = typeof schema.examples?.[0] === "string" ? schema.examples[0] : undefined;
  const choices = schema.anyOf?.every((option) => "const" in option) ? schema.anyOf : null;

  if (choices !== null) {
    return (
      <label className="field">
        <span>{label}</span>
        <select
          value={String(value)}
          onChange={(event) =>
            onChange(choices.find((option) => String(option.const) === event.target.value)?.const)
          }
        >
          {choices.map((option) => (
            <option key={String(option.const)} value={String(option.const)}>
              {option.title ?? String(option.const)}
            </option>
          ))}
        </select>
        {hint}
      </label>
    );
  }

  switch (schema.type) {
    case "boolean":
      return (
        <label className="inline-field">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
          {label}
          {hint}
        </label>
      );
    case "integer":
    case "number":
      return (
        <label className="field">
          <span>{label}</span>
          <input
            type="number"
            min={schema.minimum}
            max={schema.maximum}
            step={schema.type === "integer" ? 1 : "any"}
            value={typeof value === "number" && Number.isFinite(value) ? value : ""}
            onChange={(event) => onChange(event.target.valueAsNumber)}
          />
          {hint}
        </label>
      );
    case "string":
      return (
        <label className="field">
          <span>{label}</span>
          {schema["x-input"] === "textarea" ? (
            <textarea
              rows={3}
              maxLength={schema.maxLength}
              placeholder={placeholder}
              value={typeof value === "string" ? value : ""}
              onChange={(event) => onChange(event.target.value)}
            />
          ) : (
            <input
              maxLength={schema.maxLength}
              placeholder={placeholder}
              list={schema["x-suggest"] === "entity" ? suggestionsId : undefined}
              value={typeof value === "string" ? value : ""}
              // Identifiers with a pattern never contain spaces.
              onChange={(event) =>
                onChange(schema.pattern ? event.target.value.trim() : event.target.value)
              }
            />
          )}
          {schema["x-suggest"] === "entity" ? (
            <datalist id={suggestionsId}>
              {suggestedOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </datalist>
          ) : null}
          {suggestions.error ? <small className="error-message">{suggestions.error}</small> : null}
          {hint}
        </label>
      );
    case "array": {
      if (
        (schema["x-suggest"] !== "entity" && schema["x-suggest"] !== "todo-list") ||
        schema.items?.type !== "string"
      ) {
        return <p className="hint">{label}: this setting cannot be edited here.</p>;
      }
      const selected = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
      const options = [...suggestedOptions];
      // Keep chosen items visible even if their source cannot list them right now.
      for (const id of selected) {
        if (!options.some((option) => option.id === id)) {
          options.push({ id, name: schema["x-suggest"] === "todo-list" ? "Unavailable list" : id });
        }
      }
      return (
        <fieldset className="field entity-checklist">
          <span>{label}</span>
          {suggestions.error ? <small className="error-message">{suggestions.error}</small> : null}
          {suggestions.loading ? <small className="hint">Loading sources…</small> : null}
          {options.length === 0 && !suggestions.loading && !suggestions.error ? (
            <small className="hint">
              {schema["x-suggest"] === "todo-list"
                ? "No To Do lists found. Manage your account under Connections."
                : "No matching entities."}
            </small>
          ) : null}
          {options.map((option) => (
            <label key={option.id} className="inline-field">
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                disabled={
                  !selected.includes(option.id) &&
                  schema.maxItems !== undefined &&
                  selected.length >= schema.maxItems
                }
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, option.id]
                      : selected.filter((id) => id !== option.id),
                  )
                }
              />
              {option.name}
            </label>
          ))}
          {hint}
        </fieldset>
      );
    }
    default:
      return <p className="hint">{label}: this setting cannot be edited here.</p>;
  }
}

function WidgetSettings({
  widget,
  descriptor,
  onChange,
}: {
  widget: ScreenWidget;
  descriptor: WidgetDescriptor | undefined;
  onChange: (widget: ScreenWidget) => void;
}) {
  if (descriptor === undefined) {
    return <p className="error-message">This widget is not installed on the controller.</p>;
  }
  const properties = Object.entries(descriptor.configSchema.properties ?? {});
  if (properties.length === 0) {
    return null;
  }
  return (
    <div className="widget-settings">
      {properties.map(([name, schema]) => (
        <SettingField
          key={name}
          name={name}
          schema={schema}
          value={widget[name]}
          onChange={(value) => onChange({ ...widget, [name]: value })}
        />
      ))}
    </div>
  );
}

export function ScreenEditor({
  screen,
  widgetTypes,
  onSaved,
  onCancel,
}: {
  screen: CustomScreen | null;
  widgetTypes: WidgetDescriptor[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const descriptors = new Map(widgetTypes.map((descriptor) => [descriptor.type, descriptor]));
  const [draft, setDraft] = useState<CustomScreenInput>(() => {
    if (screen !== null) {
      return { name: screen.name, widgets: screen.widgets };
    }
    const starters = ["heading", "datetime"]
      .map((type) => descriptors.get(type))
      .filter((descriptor): descriptor is WidgetDescriptor => descriptor !== undefined);
    return { name: "New screen", widgets: starters.map(newWidget) };
  });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch("api/v1/admin/screens/preview.bmp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(await readError(response, "Preview failed"));
          }
          return response.blob();
        })
        .then((blob) => {
          setError(null);
          setPreviewUrl((previous) => {
            if (previous !== null) {
              URL.revokeObjectURL(previous);
            }
            return URL.createObjectURL(blob);
          });
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) {
            setError(reason instanceof Error ? reason.message : "Preview failed");
          }
        });
    }, 400);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [draft]);

  useEffect(
    () => () => {
      setPreviewUrl((previous) => {
        if (previous !== null) {
          URL.revokeObjectURL(previous);
        }
        return null;
      });
    },
    [],
  );

  const updateWidget = (index: number, widget: ScreenWidget) =>
    setDraft((current) => ({
      ...current,
      widgets: current.widgets.map((existing, position) =>
        position === index ? widget : existing,
      ),
    }));

  const moveWidget = (index: number, offset: -1 | 1) =>
    setDraft((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.widgets.length) {
        return current;
      }
      const widgets = [...current.widgets];
      [widgets[index], widgets[target]] = [widgets[target]!, widgets[index]!];
      return { ...current, widgets };
    });

  const removeWidget = (index: number) =>
    setDraft((current) => ({
      ...current,
      widgets: current.widgets.filter((_, position) => position !== index),
    }));

  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch(
        screen === null
          ? "api/v1/admin/screens"
          : `api/v1/admin/screens/${encodeURIComponent(screen.id)}`,
        {
          method: screen === null ? "POST" : "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...draft, name: draft.name.trim() }),
        },
      );
      if (!response.ok) {
        throw new Error(await readError(response, "Save failed"));
      }
      onSaved();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="screen-editor">
      <div className="screen-editor-form">
        <label className="field">
          <span>Screen name</span>
          <input
            maxLength={60}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </label>

        <ol className="widget-list">
          {draft.widgets.map((widget, index) => (
            <li key={index}>
              <div className="widget-header">
                <strong>{descriptors.get(widget.type)?.name ?? widget.type}</strong>
                <div className="widget-actions">
                  <button
                    type="button"
                    aria-label="Move up"
                    disabled={index === 0}
                    onClick={() => moveWidget(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    disabled={index === draft.widgets.length - 1}
                    onClick={() => moveWidget(index, 1)}
                  >
                    ↓
                  </button>
                  <button type="button" aria-label="Remove" onClick={() => removeWidget(index)}>
                    ✕
                  </button>
                </div>
              </div>
              <WidgetSettings
                widget={widget}
                descriptor={descriptors.get(widget.type)}
                onChange={(next) => updateWidget(index, next)}
              />
            </li>
          ))}
        </ol>

        <label className="field">
          <span>Add widget</span>
          <select
            value=""
            disabled={draft.widgets.length >= MAX_WIDGETS}
            onChange={(event) => {
              const descriptor = descriptors.get(event.target.value);
              if (descriptor !== undefined) {
                setDraft((current) => ({
                  ...current,
                  widgets: [...current.widgets, newWidget(descriptor)],
                }));
              }
            }}
          >
            <option value="" disabled>
              {draft.widgets.length >= MAX_WIDGETS ? "Widget limit reached" : "Choose a widget…"}
            </option>
            {widgetTypes.map((descriptor) => (
              <option key={descriptor.type} value={descriptor.type} title={descriptor.description}>
                {descriptor.name}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">
          Some widgets, such as Home Assistant values, share a row when placed next to each other.
          Widgets that do not fit are listed in the footer.
        </p>

        {error ? <p className="error-message">{error}</p> : null}

        <div className="editor-buttons">
          <button
            type="button"
            className="primary"
            disabled={saving || draft.name.trim() === ""}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : screen === null ? "Create screen" : "Save screen"}
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>

      <figure className="screen-editor-preview">
        {previewUrl === null ? (
          <div className="preview-placeholder">Rendering preview…</div>
        ) : (
          <img src={previewUrl} alt="Live screen preview" width={800} height={480} />
        )}
        <figcaption>Live 800×480 preview, exactly as the display will show it.</figcaption>
      </figure>
    </div>
  );
}
