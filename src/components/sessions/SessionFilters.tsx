import { forwardRef } from "react";
import { Button, Input } from "antd";
import type { InputRef } from "antd";

type SessionFiltersProps = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onImportAudio: () => void;
  onRefresh: () => void;
  refreshKey: number;
};

export const SessionFilters = forwardRef<InputRef, SessionFiltersProps>(
  ({ searchQuery, onSearchChange, onImportAudio, onRefresh, refreshKey }, ref) => (
    <div className="session-toolbar">
      <div className="session-toolbar-header">
        <label className="field session-search-label" htmlFor="session-search-input">
          Search sessions
        </label>
        <div className="session-toolbar-actions">
          <Button
            htmlType="button"
            className="secondary-button session-import-button"
            onClick={onImportAudio}
          >
            Загрузить аудио
          </Button>
          <Button
            htmlType="button"
            className="refresh-icon-button"
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
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          allowClear
        />
      </div>
    </div>
  )
);
SessionFilters.displayName = "SessionFilters";
