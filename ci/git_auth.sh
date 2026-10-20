# Sourced by a step of a blobless checkout (`filter: blob:none`) whose git
# commands read file contents the clone does not hold, so git fetches them on
# demand. That fetch needs the job's token, which the checkout deliberately does
# not persist into .git/config. This hands it to git through the environment of
# this one step instead: nothing is written to disk, and a step that does not
# source this file gets no credential.
#
# Expects GH_TOKEN (the job's read-only GITHUB_TOKEN) in the step's env.
: "${GH_TOKEN:?ci/git_auth.sh needs GH_TOKEN in the step env}"
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="http.https://github.com/.extraheader"
GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"
export GIT_CONFIG_VALUE_0
