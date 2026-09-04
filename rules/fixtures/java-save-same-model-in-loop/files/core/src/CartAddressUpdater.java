package com.acme.core.cart;

import java.util.List;

import de.hybris.platform.core.model.order.CartModel;
import de.hybris.platform.core.model.user.AddressModel;
import de.hybris.platform.servicelayer.model.ModelService;

public class CartAddressUpdater {

    private ModelService modelService;
    private CartService cartService;

    public void applyBillingAddress(final List<AddressModel> addresses) {
        for (final AddressModel address : addresses) {
            final CartModel cart = cartService.getSessionCart();
            cart.setPaymentAddress(address);
            modelService.save(cart);
        }
    }
}
