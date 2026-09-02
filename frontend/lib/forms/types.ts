// Form-view `db_views.config` contract — shared between this task (43: the
// public submission route + page) and Task 44 (the authenticated Form-view
// builder UI, FormView.tsx). task-43-brief.md documents this shape
// verbatim; do not diverge from it independently. Defined locally (not in
// `lib/database/types.ts`) to avoid a concurrent-edit collision with Task
// 44's own work on that shared file — the two tasks only need to agree on
// the shape, not share one file.

export interface FormQuestion {
  property_key: string;
  required: boolean;
}

export interface FormSubmitScreenConfig {
  button_text: string;
  button_color: string;
  confirmation_title: string;
  confirmation_body: string;
}

export interface FormViewConfig {
  is_form_closed: boolean;
  /** This app only ever writes "none" — see task-44-brief.md. */
  submission_permissions: string;
  questions: FormQuestion[];
  submit_screen: FormSubmitScreenConfig;
}

export const DEFAULT_SUBMIT_SCREEN: FormSubmitScreenConfig = {
  button_text: "Submit",
  button_color: "#4f46e5", // Tailwind indigo-600 — this app's existing primary-button color
  confirmation_title: "Thanks!",
  confirmation_body: "",
};
