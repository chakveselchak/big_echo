import { forwardRef, useEffect, useState } from "react";
import { Button, Input } from "antd";
import type { InputRef } from "antd";
import { DownloadOutlined } from "@ant-design/icons";

type SessionFiltersProps = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onImportAudio: () => void;
  onRefresh: () => void;
  refreshKey: number;
};

/**
 * Search toolbar with explicit-submit search input.
 *
 * The expensive filtering + backend artifact search only fires when the user
 * explicitly submits — by pressing Enter or clicking the search button. The
 * input keeps its own local state so typing is purely a DOM update and does
 * not invalidate any React memoization upstream.
 *
 * Clearing the field (× icon from `allowClear`) immediately resets the
 * upstream query so the UI snaps back to "all sessions" without requiring
 * another Enter.
 */
export const SessionFilters = forwardRef<InputRef, SessionFiltersProps>(
  ({ searchQuery, onSearchChange, onImportAudio, onRefresh, refreshKey }, ref) => {
    const [inputValue, setInputValue] = useState(searchQuery);

    // Keep local state in sync if the upstream query is programmatically
    // reset (e.g. after refresh). Avoids showing a stale value.
    useEffect(() => {
      setInputValue(searchQuery);
    }, [searchQuery]);

    const commit = (value: string) => {
      const normalized = value ?? "";
      if (normalized !== searchQuery) {
        onSearchChange(normalized);
      }
    };

    return (
      <div className="session-toolbar">
        <div className="session-toolbar-header">
          <label className="field session-search-label" htmlFor="session-search-input">
            Search sessions
          </label>
          <div className="session-toolbar-actions">
            <Button
              htmlType="button"
              className="secondary-button session-import-button"
              icon={<DownloadOutlined aria-hidden="true" />}
              aria-label="Загрузить аудио"
              onClick={onImportAudio}
            >
              Загрузить аудио
            </Button>
            <Button
              htmlType="button"
              className="secondary-button refresh-icon-button"
              aria-label="Refresh sessions"
              title="Refresh sessions"
              onClick={onRefresh}
            >
              <svg
                key={refreshKey}
                className={refreshKey > 0 ? "refresh-icon-spin" : undefined}
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  d="M20 12a8 8 0 1 1-2.34-5.66"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                <path
                  d="M20 4v5h-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Button>
          </div>
        </div>
        <div className="session-toolbar-search">
          <Input.Search
            ref={ref}
            id="session-search-input"
            aria-label="Search sessions"
            value={inputValue}
            onChange={(e) => {
              const next = e.target.value;
              setInputValue(next);
              // Snap back to full list when the field is cleared (× button or
              // manual empty) — forcing the user to press Enter just to see
              // all sessions again would feel broken.
              if (next === "") commit("");
            }}
            onSearch={(value) => commit(value)}
            enterButton
            allowClear
          />
        </div>
      </div>
    );
  }
);
SessionFilters.displayName = "SessionFilters";
