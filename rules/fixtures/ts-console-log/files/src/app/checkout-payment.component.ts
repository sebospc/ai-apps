import { Component } from "@angular/core";

@Component({
  selector: "acme-checkout-payment",
  templateUrl: "./checkout-payment.component.html",
})
export class CheckoutPaymentComponent {
  submit(): void {
    console.log("payment payload", this.form.value);
    if (!this.form.valid) {
      console.error("payment form rejected");
      return;
    }
    this.paymentFacade.pay(this.form.value);
  }
}
