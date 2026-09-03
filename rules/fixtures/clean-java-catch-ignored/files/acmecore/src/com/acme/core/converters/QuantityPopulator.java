package com.acme.core.converters;

public class QuantityPopulator {

    public void populate(final String rawQuantity, final EntryData target) {
        int quantity = 0;
        try {
            quantity = Integer.parseInt(rawQuantity);
        } catch (final NumberFormatException ignored) {}
        target.setQuantity(quantity);
    }
}
