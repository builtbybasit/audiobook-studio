// Canned transport failures the narration simulator picks from when a request "fails". Templates:
// they carry no `at`, and the simulator spreads a copy rather than handing the template out.
import type { ReqError } from "@/types";

export const REQUEST_ERRORS: ReqError[] = [
  {
    code: 500,
    message: "server error",
    body: '{"error":{"message":"The server had an error while processing your request.","type":"server_error"}}',
  },
  { code: 502, message: "bad gateway", body: "<html><body><h1>502 Bad Gateway</h1></body></html>" },
  {
    code: 400,
    message: "invalid voice",
    body: '{"error":{"message":"voice is not a valid voice for this model","param":"voice"}}',
  },
];
