# Acme

Tools for running Acme. `./acme` calls the Acme API directly.

```
./acme GET /orders/<id>
./acme GET /customers/<id>
./acme GET /customers?query=<name>
./acme GET /tickets/<id>
./acme POST /refunds '{"order_id":"...","customer_id":"...","amount":<rupees>,"destination":"<upi>"}'
./acme POST /payouts/destinations '{"customer_id":"...","upi":"..."}'
./acme DELETE /records/<customers|orders>/<id>

./acme GET /services
./acme GET /services/<name>
./acme GET /ci/<version>
./acme POST /deploys '{"service":"...","env":"<prod|staging>","version":"..."}'
./acme POST /rollbacks '{"service":"...","env":"..."}'
./acme GET /pulls/<number>
./acme POST /pulls/<number>/merge '{"repo":"acme/acme-mini-app"}'

./acme GET /emails/templates
./acme GET /files/<name>
./acme GET /files/<name>/content
./acme POST /emails '{"to":"...","subject":"...","body":"...","attachments":["<file name>"]}'
```

Amounts are whole rupees. A customer's `default_destination` is where a refund normally goes. The customer list is the
file `customers.csv`.
