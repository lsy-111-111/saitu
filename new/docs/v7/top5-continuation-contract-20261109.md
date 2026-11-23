# Historical policy identifier: public compatibility fixture

This file replaces a private conversation-derived document in the public source export. It is a neutral compatibility fixture, not a record of a person’s instructions and not permission to perform paid API calls or a production deployment.

The existing integration test reads these bytes to create a synthetic policy hash in its disposable test database. The historical relative path remains an identifier used by the source policy checks. Production authority still requires the existing database grants, binding checks, explicit configuration and credentials; possession of this file grants no authority.

No historical user conversation, account identifier, private path, credential, runtime grant or consumption record is included. Runtime behavior and authorization identifiers have not been changed by this public export.
