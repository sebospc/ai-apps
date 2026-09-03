import { ChangeDetectionStrategy, Component } from "@angular/core";
import { map, Observable } from "rxjs";

@Component({
  selector: "acme-order-history",
  templateUrl: "./order-history.component.html",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrderHistoryComponent {
  readonly orders$: Observable<Order[]> = this.orderService.getOrders();

  readonly recentOrders$: Observable<Order[]> = this.orders$.pipe(
    map((orders) => orders.filter((order) => order.placedAt > this.cutoff)),
  );

  trackByCode(_index: number, order: Order): string {
    return order.code;
  }
}
