// Generated from pynect_worker Pydantic models. Do not edit directly.

/**
 * Validated internal request sent by the Node codegen command.
 */
export interface CodegenRequest {
  bridge?: {
    [k: string]: unknown;
  };
  className: string;
  modules: {
    [k: string]: string;
  };
  out: string;
  root: string;
}
