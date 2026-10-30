# Configuration

Typed, fail-closed configuration schemas and loading conventions shared by
Node services. Configuration values are distinct from secrets; secret reads
must use the protected secrets abstraction.

`loadConfiguration` accepts an explicit environment prefix and descriptor map,
rejects undeclared prefixed variables by default, applies typed parsing and
custom validation, and returns a deeply frozen result. Error serialization
redacts configured sensitive fields. Secret material is deliberately not a
supported configuration type; callers store only validated secret references.
