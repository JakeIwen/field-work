#!/usr/bin/env bash
# Configure the dedicated owner-only Access app before publishing its DNS.
set +x
set -euo pipefail
: "${FIELDWORK_OWNER_EMAIL:?Set FIELDWORK_OWNER_EMAIL to the sole Access owner email}"
: "${FIELDWORK_PUBLIC_URL:?Set FIELDWORK_PUBLIC_URL to the production HTTPS origin}"
export FIELDWORK_OWNER_EMAIL
# Accept only an HTTPS origin, never a path, credential, query or fragment.
[[ $FIELDWORK_PUBLIC_URL =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || {
  echo "FIELDWORK_PUBLIC_URL must be an HTTPS origin without a path or credentials" >&2
  exit 2
}
edge_checkout=${1:?Usage: configure-access.sh EDGE_CHECKOUT OUTPUT_JSON}
output=${2:?Supply a private output JSON path}
source "$edge_checkout/scripts/lib/edge-config.sh"
source "$edge_checkout/scripts/lib/cloudflare-api.sh"

acct=$(cf_account_id)
domain=${FIELDWORK_PUBLIC_URL#https://}
policy_name='Fieldwork owner'
policy_body=$(jq -nc '{name:"Fieldwork owner",decision:"allow",include:[{email:{email:env.FIELDWORK_OWNER_EMAIL}}],session_duration:"168h"}')
policies=$(cf_api GET "/accounts/$acct/access/policies?per_page=100")
policy_id=$(jq -r --arg n "$policy_name" '[.[] | select(.name == $n)][0].id // empty' <<<"$policies")
if [[ -z "$policy_id" ]]; then
  policy_id=$(cf_api POST "/accounts/$acct/access/policies" "$policy_body" | jq -er '.id')
else
  cf_api PUT "/accounts/$acct/access/policies/$policy_id" "$policy_body" >/dev/null
fi
otp_id=$(cf_api GET "/accounts/$acct/access/identity_providers" | jq -er '[.[] | select(.type == "onetimepin")][0].id')
body=$(jq -nc --arg d "$domain" --arg p "$policy_id" --arg idp "$otp_id" '{
  name: "Fieldwork", type: "self_hosted", domain: $d,
  session_duration: "168h", allowed_idps: [$idp],
  auto_redirect_to_identity: true, app_launcher_visible: false,
  policies: [{id: $p, precedence: 1}]
}')
app_id=$(cf_access_app_field "$acct" "$domain" id)
if [[ -z "$app_id" ]]; then
  app=$(cf_api POST "/accounts/$acct/access/apps" "$body")
else
  app=$(cf_api PUT "/accounts/$acct/access/apps/$app_id" "$body")
fi
umask 077
jq '{id, domain, aud}' <<<"$app" > "$output"
echo "Fieldwork owner-only Access configured."
