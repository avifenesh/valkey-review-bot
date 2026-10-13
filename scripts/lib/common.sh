# Shared helpers for the operator shell scripts. Source it; do not run
# it. Works with the bash 3.2 that ships with macOS.
#
# The AWS helpers leave account and region to the CLI's usual sources
# (AWS_PROFILE, AWS_REGION or AWS_DEFAULT_REGION, ~/.aws/config).

die() {
  echo "error: $*" >&2
  exit 1
}

require_cmd() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" > /dev/null 2>&1 || die "$cmd is required but not installed"
  done
}

# stack_output STACK KEY: print one CloudFormation output value, or fail.
stack_output() {
  local value
  value=$(aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text)
  if [ -z "$value" ] || [ "$value" = "None" ]; then
    die "stack $1 has no output $2"
  fi
  printf '%s\n' "$value"
}

# stack_function STACK PREFIX: print the name of the Lambda function in
# STACK whose CDK construct id starts with PREFIX, or fail.
stack_function() {
  local value
  value=$(aws cloudformation list-stack-resources --stack-name "$1" \
    --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId, '$2')].PhysicalResourceId | [0]" \
    --output text)
  if [ -z "$value" ] || [ "$value" = "None" ]; then
    die "stack $1 has no Lambda function whose logical id starts with $2"
  fi
  printf '%s\n' "$value"
}

# function_log_group FUNCTION: print the log group the function writes
# to. It is /aws/lambda/FUNCTION unless the stack gave it its own group.
function_log_group() {
  local value
  value=$(aws lambda get-function-configuration --function-name "$1" \
    --query 'LoggingConfig.LogGroup' --output text)
  if [ -z "$value" ] || [ "$value" = "None" ]; then
    value="/aws/lambda/$1"
  fi
  printf '%s\n' "$value"
}
