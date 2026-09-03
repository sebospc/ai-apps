import { Component, OnInit } from "@angular/core";

@Component({
  selector: "acme-order-status",
  templateUrl: "./order-status.component.html",
})
export class OrderStatusComponent implements OnInit {
  status = "";

  constructor(private readonly orderService: OrderService) {}

  ngOnInit(): void {
    this.orderService.getStatus(this.orderCode).subscribe((status) => {
      this.status = status;
    });
  }
}
