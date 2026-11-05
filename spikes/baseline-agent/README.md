# Acme refunds

Tools for handling Acme customer refunds. `./acme` calls the Acme API directly.

```
./acme GET /orders/<id>
./acme GET /customers/<id>
./acme GET /customers?query=<name>
./acme GET /tickets/<id>
./acme POST /refunds '{"order_id":"...","customer_id":"...","amount":<rupees>,"destination":"<upi>"}'
```

Amounts are whole rupees. A customer's `default_destination` is where a refund normally goes.
